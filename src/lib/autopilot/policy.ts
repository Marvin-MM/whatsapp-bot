import type { DraftIntent } from '@/lib/ai/schemas';
import type { QuietHours } from '@/lib/db/schema';
import { isQuietNow } from '@/lib/notify/quiet-hours';

/**
 * The per-draft autopilot decision (spec 10.2). Everything here is PURE: every fact is passed in, so each rule is tested on its own and the
 * same functions serve the decision after drafting and the re-check just before sending. A rule that fails does not "block" anything: it
 * routes the draft to the owner's approval queue, which is where every draft goes by default.
 *
 * All failing rules are reported (not just the first), in a fixed order, so the owner sees the whole picture and the numbers behind the
 * analytics ("why do drafts get routed?") are complete.
 */

export const ROUTE_REASONS = [
  'not_autopilot_mode',
  'autopilot_expired',
  'gate_failed',
  'autopilot_paused',
  'risk_flags',
  'missing_facts',
  'placeholder',
  'intent_not_allowed',
  'intent_needs_owner',
  'no_reply_needed',
  'window_closing',
  'rate_limit_conversation',
  'rate_limit_daily',
  'consecutive_cap',
  'likely_bot',
  'quiet_hours',
  'few_owner_messages',
  'transcript_trigger',
  'verifier_failed',
  'verifier_error',
  // Raised only by the send itself (the send path's own pre-check has the last word):
  'sending_paused',
  'draft_stale',
  'send_refused',
  'countdown_lost',
] as const;

export type RouteReason = (typeof ROUTE_REASONS)[number];

/** In words, for the dashboard, the Telegram digest and the analytics breakdown. */
export const ROUTE_REASON_TEXT: Record<RouteReason, string> = {
  not_autopilot_mode: 'The conversation is in approval mode',
  autopilot_expired: 'The autopilot period for this conversation ended',
  gate_failed: 'Autopilot has not earned its trust yet (see the eligibility checks)',
  autopilot_paused: 'Autopilot is paused',
  risk_flags: 'The draft carries a risk flag',
  missing_facts: 'The draft is missing a fact',
  placeholder: 'The draft still has a [[placeholder]]',
  intent_not_allowed: 'This kind of message is not on the allowed list',
  intent_needs_owner: 'A complaint or a request for a human',
  no_reply_needed: 'No reply was needed (e.g. "ok", "thanks")',
  window_closing: 'The 24-hour window closes within 10 minutes',
  rate_limit_conversation: 'Too many automatic replies in this conversation this hour',
  rate_limit_daily: 'Too many automatic replies today',
  consecutive_cap: 'Too many automatic replies in a row without you',
  likely_bot: 'The other side answers within seconds every time: probably another bot',
  quiet_hours: 'Quiet hours',
  few_owner_messages: 'You have written fewer than 3 messages to this customer',
  transcript_trigger: 'The customer sent a voice note (the transcript is machine-made)',
  verifier_failed: 'The independent check did not pass the reply',
  verifier_error: 'The independent check could not run',
  sending_paused: 'Sending is paused',
  draft_stale: 'The customer wrote again before it was sent',
  send_refused: 'The send path refused it',
  countdown_lost: 'The countdown was lost (the worker or Redis was down), so it was not sent',
};

/** A customer asking for a person, or complaining, is never answered by the machine (rule 4). */
export const NEVER_AUTOPILOT_INTENTS: readonly DraftIntent[] = ['asks_for_human', 'complaint'];

/** Rule 6: a reply must go out with this much of the 24-hour window to spare. */
export const WINDOW_MARGIN_MS = 10 * 60 * 1000;
/** Rule 8: three customer messages each this soon after our previous message look like another bot. */
export const BOT_GAP_SECONDS = 5;
/** Rule 10: no autopilot on near-strangers. */
export const MIN_OWNER_MESSAGES = 3;

export interface PolicyInput {
  now: Date;
  timeZone: string;
  conversation: {
    replyMode: 'approval' | 'autopilot';
    autopilotUntil: Date | null;
    windowExpiresAt: Date | null;
    consecutiveAutoReplies: number;
    /** Messages the owner wrote (typed, typed on the phone, imported, or an AI draft they edited), not counting failed sends. */
    ownerMessageCount: number;
  };
  draft: {
    content: string;
    intent: DraftIntent;
    riskFlags: readonly string[];
    missingFacts: readonly string[];
    noReplyNeeded: boolean;
    /** Any message this draft answers is a voice note (its text is a machine transcript). */
    answersTranscript: boolean;
  };
  settings: {
    autopilotPaused: boolean;
    allowedIntents: readonly string[];
    maxPerConversationPerHour: number;
    maxPerDay: number;
    maxConsecutive: number;
    quietHours: QuietHours | null;
  };
  /** The system-wide eligibility gate (computed live by `eligibility.ts`). */
  gateEligible: boolean;
  usage: {
    /** Automatic replies sent (or queued) in THIS conversation in the last hour. */
    conversationLastHour: number;
    /** Automatic replies sent (or queued) across all conversations since the owner's local midnight. */
    today: number;
  };
  /**
   * For the customer's last (up to) three messages, newest first: seconds between our previous message and theirs, or null when we had
   * not written before it. Fewer than three entries means "not enough history to suspect a bot".
   */
  recentCustomerGapsSeconds: ReadonlyArray<number | null>;
}

const when = (condition: boolean, reason: RouteReason): RouteReason[] => (condition ? [reason] : []);

// ------------------------------------------------------------------------------------------------------------------ single rules
// One function per rule of spec 10.2, in the spec's numbering, so the tests can name each one.

/** Rule 1. */
export function ruleMode(input: PolicyInput): RouteReason[] {
  if (input.conversation.replyMode !== 'autopilot') return ['not_autopilot_mode'];
  const until = input.conversation.autopilotUntil;
  return until !== null && until.getTime() <= input.now.getTime() ? ['autopilot_expired'] : [];
}

/** Rule 2 (and the kill switch: a paused autopilot never sends, whatever the gate says). */
export function ruleGate(input: PolicyInput): RouteReason[] {
  return [...when(input.settings.autopilotPaused, 'autopilot_paused'), ...when(!input.gateEligible, 'gate_failed')];
}

/** Rule 3. */
export function ruleDraftContent(input: PolicyInput): RouteReason[] {
  return [...when(input.draft.riskFlags.length > 0, 'risk_flags'), ...when(input.draft.missingFacts.length > 0, 'missing_facts'), ...when(input.draft.content.includes('[['), 'placeholder')];
}

/** Rule 4. */
export function ruleIntent(input: PolicyInput): RouteReason[] {
  const intent = input.draft.intent;
  return [...when(!input.settings.allowedIntents.includes(intent), 'intent_not_allowed'), ...when(NEVER_AUTOPILOT_INTENTS.includes(intent), 'intent_needs_owner')];
}

/** Rule 5. */
export function ruleNoReply(input: PolicyInput): RouteReason[] {
  return when(input.draft.noReplyNeeded, 'no_reply_needed');
}

/** Rule 6: an unknown window counts as closing. */
export function ruleWindow(input: PolicyInput): RouteReason[] {
  const expires = input.conversation.windowExpiresAt;
  return when(expires === null || expires.getTime() - input.now.getTime() < WINDOW_MARGIN_MS, 'window_closing');
}

/** Rule 7. */
export function ruleRateLimits(input: PolicyInput): RouteReason[] {
  return [
    ...when(input.usage.conversationLastHour >= input.settings.maxPerConversationPerHour, 'rate_limit_conversation'),
    ...when(input.usage.today >= input.settings.maxPerDay, 'rate_limit_daily'),
  ];
}

/** Rule 8. */
export function ruleLoopGuard(input: PolicyInput): RouteReason[] {
  const gaps = input.recentCustomerGapsSeconds;
  const pingPong = gaps.length >= 3 && gaps.slice(0, 3).every((gap) => gap !== null && gap < BOT_GAP_SECONDS);
  return [...when(input.conversation.consecutiveAutoReplies >= input.settings.maxConsecutive, 'consecutive_cap'), ...when(pingPong, 'likely_bot')];
}

/** Rule 9. A malformed or absent setting means no quiet hours (`isQuietNow` already says so). */
export function ruleQuietHours(input: PolicyInput): RouteReason[] {
  const quiet = input.settings.quietHours;
  return when(quiet !== null && isQuietNow(input.now, quiet, input.timeZone), 'quiet_hours');
}

/** Rule 10. */
export function ruleKnownCustomer(input: PolicyInput): RouteReason[] {
  return when(input.conversation.ownerMessageCount < MIN_OWNER_MESSAGES, 'few_owner_messages');
}

/** Our own addition to spec 10.2 (D-093): a machine transcript of a voice note (Luganda in particular) is never trusted to be answered unseen. */
export function ruleTranscript(input: PolicyInput): RouteReason[] {
  return when(input.draft.answersTranscript, 'transcript_trigger');
}

// ------------------------------------------------------------------------------------------------------------------ the decisions

/** Rules 1-10 plus the transcript rule: everything that can be decided without calling the verifier. */
export function checkPreVerifier(input: PolicyInput): RouteReason[] {
  return [
    ...ruleMode(input),
    ...ruleGate(input),
    ...ruleDraftContent(input),
    ...ruleIntent(input),
    ...ruleNoReply(input),
    ...ruleWindow(input),
    ...ruleRateLimits(input),
    ...ruleLoopGuard(input),
    ...ruleQuietHours(input),
    ...ruleKnownCustomer(input),
    ...ruleTranscript(input),
  ];
}

/**
 * Just before sending (spec 10.3): the state may have changed during the delay, so the rules that depend on state are asked again:
 * 1, 2, 6, 7, 8 and 9. The draft's own content (rules 3-5, 10) cannot have changed; a new customer message supersedes the draft
 * instead, and the send path's own pre-check (kill switch, window, staleness) has the last word.
 */
export function checkAtSend(input: PolicyInput): RouteReason[] {
  return [...ruleMode(input), ...ruleGate(input), ...ruleWindow(input), ...ruleRateLimits(input), ...ruleLoopGuard(input), ...ruleQuietHours(input)];
}

export interface VerifierOutput {
  unsupportedClaims: readonly string[];
  commitments: readonly string[];
  answersTheCustomer: boolean;
  toneRisk: boolean;
  verdict: 'pass' | 'fail';
}

/** Spec 9.7: `pass` only if the verdict says so AND both lists are empty AND it answers the customer AND the tone is safe. */
export function verifierPasses(output: VerifierOutput): boolean {
  return output.verdict === 'pass' && output.unsupportedClaims.length === 0 && output.commitments.length === 0 && output.answersTheCustomer && !output.toneRisk;
}

export type Decision = { action: 'schedule'; reasons: [] } | { action: 'route_to_approval'; reasons: RouteReason[] };

/**
 * `verifier`: what the independent check returned, or `'error'` when it could not run (any error is a failure), or `null` when it has not
 * been asked. The verifier is only worth calling when rules 1-10 pass, so a draft that fails one of them is routed without it.
 */
export function decideAutopilot(input: PolicyInput, verifier: VerifierOutput | 'error' | null): Decision {
  const reasons = checkPreVerifier(input);
  if (reasons.length > 0) return { action: 'route_to_approval', reasons };
  if (verifier === null || verifier === 'error') return { action: 'route_to_approval', reasons: ['verifier_error'] };
  if (!verifierPasses(verifier)) return { action: 'route_to_approval', reasons: ['verifier_failed'] };
  return { action: 'schedule', reasons: [] };
}
