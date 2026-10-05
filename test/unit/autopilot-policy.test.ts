import { describe, expect, it } from 'vitest';
import {
  BOT_GAP_SECONDS,
  MIN_OWNER_MESSAGES,
  type PolicyInput,
  ROUTE_REASONS,
  ROUTE_REASON_TEXT,
  type VerifierOutput,
  WINDOW_MARGIN_MS,
  checkAtSend,
  checkPreVerifier,
  decideAutopilot,
  verifierPasses,
} from '@/lib/autopilot/policy';

// 2026-10-05 12:00 UTC = 15:00 in Kampala (UTC+3), well outside the default quiet hours (22:00-07:00).
const NOW = new Date('2026-10-05T12:00:00Z');
const MIN = 60 * 1000;

/** A draft that passes every rule. Each test changes exactly one thing. */
function base(): PolicyInput {
  return {
    now: NOW,
    timeZone: 'Africa/Kampala',
    conversation: {
      replyMode: 'autopilot',
      autopilotUntil: null,
      windowExpiresAt: new Date(NOW.getTime() + 5 * 60 * MIN),
      consecutiveAutoReplies: 0,
      ownerMessageCount: 10,
    },
    draft: { content: 'Yes, we are open until 6pm.', intent: 'question', riskFlags: [], missingFacts: [], noReplyNeeded: false, answersTranscript: false },
    settings: {
      autopilotPaused: false,
      allowedIntents: ['chit_chat', 'question'],
      maxPerConversationPerHour: 3,
      maxPerDay: 30,
      maxConsecutive: 4,
      quietHours: { start: '22:00', end: '07:00' },
    },
    gateEligible: true,
    usage: { conversationLastHour: 0, today: 0 },
    recentCustomerGapsSeconds: [40, 90, 300],
  };
}

const PASS: VerifierOutput = { unsupportedClaims: [], commitments: [], answersTheCustomer: true, toneRisk: false, verdict: 'pass' };

function with_(change: (input: PolicyInput) => void): PolicyInput {
  const input = base();
  change(input);
  return input;
}

describe('the all-pass case', () => {
  it('schedules a draft that passes every rule and the verifier', () => {
    expect(checkPreVerifier(base())).toEqual([]);
    expect(decideAutopilot(base(), PASS)).toEqual({ action: 'schedule', reasons: [] });
  });
});

describe('spec 10.2: each rule routes to approval, and says why', () => {
  const cases: Array<[string, (input: PolicyInput) => void, string[]]> = [
    ['1. the conversation is in approval mode', (i) => (i.conversation.replyMode = 'approval'), ['not_autopilot_mode']],
    ['1. the autopilot period has passed', (i) => (i.conversation.autopilotUntil = new Date(NOW.getTime() - 1)), ['autopilot_expired']],
    ['1. the autopilot period ends exactly now', (i) => (i.conversation.autopilotUntil = new Date(NOW.getTime())), ['autopilot_expired']],
    ['2. the eligibility gate fails', (i) => (i.gateEligible = false), ['gate_failed']],
    ['2. autopilot is paused', (i) => (i.settings.autopilotPaused = true), ['autopilot_paused']],
    ['3. the draft has a risk flag', (i) => (i.draft.riskFlags = ['money_or_commitment']), ['risk_flags']],
    ['3. the draft names a missing fact', (i) => (i.draft.missingFacts = ['delivery fee']), ['missing_facts']],
    ['3. the reply contains a [[placeholder]]', (i) => (i.draft.content = 'Delivery is [[fee]].'), ['placeholder']],
    ['3. an unterminated placeholder marker is still caught', (i) => (i.draft.content = 'Delivery is [[fee'), ['placeholder']],
    ['4. the intent is not on the allowed list', (i) => (i.draft.intent = 'order'), ['intent_not_allowed']],
    ['4. asks_for_human, even when it is on the allowed list', (i) => { i.draft.intent = 'asks_for_human'; i.settings.allowedIntents = ['asks_for_human']; }, ['intent_needs_owner']],
    ['4. complaint, even when it is on the allowed list', (i) => { i.draft.intent = 'complaint'; i.settings.allowedIntents = ['complaint']; }, ['intent_needs_owner']],
    ['5. no reply is needed', (i) => (i.draft.noReplyNeeded = true), ['no_reply_needed']],
    ['6. the window closes in under 10 minutes', (i) => (i.conversation.windowExpiresAt = new Date(NOW.getTime() + WINDOW_MARGIN_MS - 1)), ['window_closing']],
    ['6. the window has already closed', (i) => (i.conversation.windowExpiresAt = new Date(NOW.getTime() - MIN)), ['window_closing']],
    ['6. there is no window at all', (i) => (i.conversation.windowExpiresAt = null), ['window_closing']],
    ['7. this conversation has had its automatic replies this hour', (i) => (i.usage.conversationLastHour = 3), ['rate_limit_conversation']],
    ['7. the day\'s automatic replies are used up', (i) => (i.usage.today = 30), ['rate_limit_daily']],
    ['8. too many automatic replies in a row', (i) => (i.conversation.consecutiveAutoReplies = 4), ['consecutive_cap']],
    ['8. three customer messages each within seconds of ours (another bot)', (i) => (i.recentCustomerGapsSeconds = [1, 2, 4]), ['likely_bot']],
    ['9. quiet hours (23:30 in Kampala)', (i) => (i.now = new Date('2026-10-05T20:30:00Z')), ['quiet_hours', 'window_closing']],
    ['10. fewer than three messages from the owner', (i) => (i.conversation.ownerMessageCount = MIN_OWNER_MESSAGES - 1), ['few_owner_messages']],
    ['+ the customer sent a voice note (machine transcript)', (i) => (i.draft.answersTranscript = true), ['transcript_trigger']],
  ];

  it.each(cases)('%s', (_name, change, expected) => {
    const input = with_(change);
    const reasons = checkPreVerifier(input);
    // Rule 9's case also moves "now" past the window's expiry, so both are expected there.
    expect([...reasons].sort()).toEqual([...expected].sort());
    const decision = decideAutopilot(input, PASS);
    expect(decision.action).toBe('route_to_approval');
    expect(decision.reasons).toEqual(reasons);
  });
});

describe('boundaries', () => {
  it('a window with exactly 10 minutes left is enough; one millisecond less is not', () => {
    expect(checkPreVerifier(with_((i) => (i.conversation.windowExpiresAt = new Date(NOW.getTime() + WINDOW_MARGIN_MS))))).toEqual([]);
    expect(checkPreVerifier(with_((i) => (i.conversation.windowExpiresAt = new Date(NOW.getTime() + WINDOW_MARGIN_MS - 1))))).toEqual(['window_closing']);
  });

  it('the limits are "at least": one below passes, the limit itself routes', () => {
    expect(checkPreVerifier(with_((i) => (i.usage.conversationLastHour = 2)))).toEqual([]);
    expect(checkPreVerifier(with_((i) => (i.usage.today = 29)))).toEqual([]);
    expect(checkPreVerifier(with_((i) => (i.conversation.consecutiveAutoReplies = 3)))).toEqual([]);
    expect(checkPreVerifier(with_((i) => (i.conversation.ownerMessageCount = MIN_OWNER_MESSAGES)))).toEqual([]);
  });

  it('five seconds is not "within seconds": the loop guard needs every one of the last three under the limit', () => {
    expect(checkPreVerifier(with_((i) => (i.recentCustomerGapsSeconds = [1, 2, BOT_GAP_SECONDS])))).toEqual([]);
    expect(checkPreVerifier(with_((i) => (i.recentCustomerGapsSeconds = [1, 2, null])))).toEqual([]);
    expect(checkPreVerifier(with_((i) => (i.recentCustomerGapsSeconds = [1, 2])))).toEqual([]);
    expect(checkPreVerifier(with_((i) => (i.recentCustomerGapsSeconds = [1, 2, 3, 600])))).toEqual(['likely_bot']);
  });

  it('quiet hours that cross midnight cover both sides of it, and the end is exclusive', () => {
    const at = (iso: string) => with_((i) => { i.now = new Date(iso); i.conversation.windowExpiresAt = new Date(new Date(iso).getTime() + 5 * 60 * MIN); });
    expect(checkPreVerifier(at('2026-10-05T19:00:00Z'))).toEqual(['quiet_hours']); // 22:00 Kampala
    expect(checkPreVerifier(at('2026-10-05T03:59:00Z'))).toEqual(['quiet_hours']); // 06:59
    expect(checkPreVerifier(at('2026-10-05T04:00:00Z'))).toEqual([]); // 07:00
    expect(checkPreVerifier(at('2026-10-05T18:59:00Z'))).toEqual([]); // 21:59
  });

  it('no quiet hours configured means none (never a silent block)', () => {
    expect(checkPreVerifier(with_((i) => { i.settings.quietHours = null; i.now = new Date('2026-10-05T20:30:00Z'); i.conversation.windowExpiresAt = new Date('2026-10-06T20:30:00Z'); }))).toEqual([]);
  });

  it('reports every failing rule, in a stable order, not only the first', () => {
    const input = with_((i) => {
      i.conversation.replyMode = 'approval';
      i.gateEligible = false;
      i.draft.riskFlags = ['legal'];
      i.draft.intent = 'complaint';
      i.draft.noReplyNeeded = true;
      i.conversation.ownerMessageCount = 0;
    });
    expect(checkPreVerifier(input)).toEqual(['not_autopilot_mode', 'gate_failed', 'risk_flags', 'intent_not_allowed', 'intent_needs_owner', 'no_reply_needed', 'few_owner_messages']);
  });
});

describe('spec 9.7 / 10.2 rule 11: the verifier', () => {
  const cases: Array<[string, VerifierOutput]> = [
    ['says fail', { ...PASS, verdict: 'fail' }],
    ['lists an unsupported claim although it says pass', { ...PASS, unsupportedClaims: ['we deliver to Gulu'] }],
    ['lists a commitment although it says pass', { ...PASS, commitments: ['promises delivery tomorrow'] }],
    ['says the reply does not answer the customer', { ...PASS, answersTheCustomer: false }],
    ['flags the tone', { ...PASS, toneRisk: true }],
  ];

  it.each(cases)('a verifier that %s does not pass the draft', (_name, output) => {
    expect(verifierPasses(output)).toBe(false);
    expect(decideAutopilot(base(), output)).toEqual({ action: 'route_to_approval', reasons: ['verifier_failed'] });
  });

  it('an error, or no answer at all, is a failure', () => {
    expect(decideAutopilot(base(), 'error')).toEqual({ action: 'route_to_approval', reasons: ['verifier_error'] });
    expect(decideAutopilot(base(), null)).toEqual({ action: 'route_to_approval', reasons: ['verifier_error'] });
  });

  it('is not asked about a draft that already fails a rule: the rule\'s reasons are reported, never the verifier\'s', () => {
    const input = with_((i) => (i.gateEligible = false));
    expect(decideAutopilot(input, PASS).reasons).toEqual(['gate_failed']);
    expect(decideAutopilot(input, { ...PASS, verdict: 'fail' }).reasons).toEqual(['gate_failed']);
  });
});

describe('the re-check just before sending (spec 10.3: rules 1, 2, 6, 7, 8, 9)', () => {
  it('passes for the unchanged all-pass state', () => {
    expect(checkAtSend(base())).toEqual([]);
  });

  it.each([
    ['1', (i: PolicyInput) => (i.conversation.replyMode = 'approval'), ['not_autopilot_mode']],
    ['1 (expired meanwhile)', (i: PolicyInput) => (i.conversation.autopilotUntil = new Date(NOW.getTime() - 1)), ['autopilot_expired']],
    ['2 (paused meanwhile)', (i: PolicyInput) => (i.settings.autopilotPaused = true), ['autopilot_paused']],
    ['2 (the gate stopped passing)', (i: PolicyInput) => (i.gateEligible = false), ['gate_failed']],
    ['6', (i: PolicyInput) => (i.conversation.windowExpiresAt = new Date(NOW.getTime() + 2 * MIN)), ['window_closing']],
    ['7', (i: PolicyInput) => (i.usage.today = 30), ['rate_limit_daily']],
    ['8', (i: PolicyInput) => (i.conversation.consecutiveAutoReplies = 4), ['consecutive_cap']],
    ['9 (the delay ran into quiet hours)', (i: PolicyInput) => { i.now = new Date('2026-10-05T19:30:00Z'); i.conversation.windowExpiresAt = new Date('2026-10-06T19:30:00Z'); }, ['quiet_hours']],
  ])('rule %s is asked again and routes', (_name, change, expected) => {
    expect(checkAtSend(with_(change))).toEqual(expected);
  });

  it('does not re-ask the content rules (they cannot change while the draft waits)', () => {
    const input = with_((i) => {
      i.draft.riskFlags = ['legal'];
      i.draft.intent = 'order';
      i.draft.noReplyNeeded = true;
      i.conversation.ownerMessageCount = 0;
      i.draft.answersTranscript = true;
    });
    expect(checkAtSend(input)).toEqual([]);
  });
});

describe('the reasons', () => {
  it('every reason code has a sentence for the owner', () => {
    for (const reason of ROUTE_REASONS) expect(ROUTE_REASON_TEXT[reason].length).toBeGreaterThan(10);
    expect(Object.keys(ROUTE_REASON_TEXT).sort()).toEqual([...ROUTE_REASONS].sort());
  });
});
