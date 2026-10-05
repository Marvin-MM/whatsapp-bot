import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache } from '@/lib/ai/run';
import { runAutopilotForDraft } from '@/lib/autopilot/decide';
import { autopilotJobKey } from '@/lib/autopilot/jobs';
import { getDb } from '@/lib/db';
import { generateDraftForConversation } from '@/lib/drafts/generate';
import { toJobId } from '@/lib/queue/enqueue';
import { getQueue } from '@/lib/queue/queues';
import { MIN, type World, seedAutopilotWorld } from '../helpers/autopilot';
import { chatCompletion } from '../helpers/groq';
import { NOW, count, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { jsonResponse, stubNetwork } from '../helpers/network';

const h = setupIngestHarness();
const sql = () => h.admin();

beforeEach(async () => {
  resetStrictCache();
  resetModelProvider();
  await getQueue('autopilot-send').obliterate({ force: true });
});
afterEach(() => vi.unstubAllGlobals());

const verdict = (over: Record<string, unknown> = {}) => chatCompletion(JSON.stringify({ unsupportedClaims: [], commitments: [], answersTheCustomer: true, toneRisk: false, verdict: 'pass', ...over }));
const draftAnswer = (over: Record<string, unknown> = {}) =>
  chatCompletion(JSON.stringify({ intent: 'question', analysis: 'Asks the closing time.', missingFacts: [], riskFlags: [], noReplyNeeded: false, reply: 'We close at 6pm 🙏', ...over }));

const telegramOk = (request: { url: string }) => (request.url.endsWith('/answerCallbackQuery') ? jsonResponse({ ok: true, result: true }) : jsonResponse({ ok: true, result: { message_id: 4242 } }));
function network(groq: Parameters<typeof stubNetwork>[0]['groq'] = () => verdict()) {
  return stubNetwork({ groq, telegram: telegramOk });
}
const verifierCalls = (net: ReturnType<typeof network>) => net.groq.filter((request) => (request.body?.model as string | undefined) === 'test-verify-model');

const draft = async (id: string) => {
  const [row] = await sql()<{ status: string; scheduled_send_at: Date | null; autopilot_decision: { eligible: boolean; reasons: string[]; verifier: Record<string, unknown> | null } | null }[]>`SELECT status, scheduled_send_at, autopilot_decision FROM drafts WHERE id = ${id}`;
  if (!row) throw new Error('no draft');
  return row;
};
const job = (draftId: string) => getQueue('autopilot-send').getJob(toJobId(autopilotJobKey(draftId)));
const audits = (action: string) => sql()<{ actor: string; entity_id: string; metadata: Record<string, unknown> }[]>`SELECT actor, entity_id, metadata FROM audit_log WHERE action = ${action} ORDER BY created_at`;
const run = (world: World, now = NOW) => runAutopilotForDraft(getDb(), world.draftId, now);

describe('a conversation that is not on autopilot', () => {
  it('is left entirely alone: no verifier call, no countdown, nothing recorded', async () => {
    const world = await seedAutopilotWorld(sql(), { replyMode: 'approval' });
    const net = network();
    expect(await run(world)).toEqual({ kind: 'not_applicable' });
    expect(net.groq).toHaveLength(0);
    expect(net.telegram).toHaveLength(0);
    expect((await draft(world.draftId)).status).toBe('pending');
    expect((await draft(world.draftId)).autopilot_decision).toBeNull();
    expect(await job(world.draftId)).toBeUndefined();
  });
});

describe('all rules pass and the verifier passes: the draft is scheduled', () => {
  it('becomes `scheduled` for now + the delay, with a countdown job, a phone message with two buttons, an event and an audit entry', async () => {
    const world = await seedAutopilotWorld(sql(), { delaySeconds: 90 });
    const net = network();
    const outcome = await run(world);

    expect(outcome.kind).toBe('scheduled');
    const row = await draft(world.draftId);
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_send_at?.toISOString()).toBe(new Date(NOW.getTime() + 90 * 1000).toISOString());
    expect(row.autopilot_decision).toMatchObject({ eligible: true, reasons: [], verifier: { verdict: 'pass', answersTheCustomer: true, toneRisk: false } });

    const queued = await job(world.draftId);
    expect(queued?.name).toBe('send');
    expect(queued?.data).toEqual({ draftId: world.draftId });
    expect(queued?.opts.delay).toBe(90_000);
    expect(queued?.opts.attempts).toBe(1);

    expect(verifierCalls(net)).toHaveLength(1);
    const buttons = net.telegram.filter((request) => request.url.endsWith('/sendMessage'));
    expect(buttons).toHaveLength(1);
    const body = buttons[0]?.body ?? {};
    const text = String(body.text);
    expect(text).toContain('Amina');
    expect(text).toContain('We close at 6pm 🙏');
    expect(text).toContain('90 seconds');
    expect(text).not.toContain('What time do you close?'); // the customer's own words are never in the phone message
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Cancel', callback_data: `ap:cancel:${world.draftId}` }, { text: 'Send now', callback_data: `ap:send:${world.draftId}` }]],
    });
    const [saved] = await sql()<{ telegram_message_id: string }[]>`SELECT telegram_message_id FROM notifications WHERE dedupe_key = ${`autopilot_scheduled:${world.draftId}`}`;
    expect(saved?.telegram_message_id).toBe('4242');

    expect(await audits('autopilot.schedule')).toEqual([{ actor: 'autopilot', entity_id: world.draftId, metadata: { conversationId: world.conversationId, delaySeconds: 90 } }]);
    expect(await count(sql(), 'messages', `direction = 'outbound' AND provenance = 'ai_autopilot'`)).toBe(0); // scheduling sends nothing
  });

  it('shows a customer with no name by the last four digits of the number, never the whole number', async () => {
    const world = await seedAutopilotWorld(sql());
    await sql()`UPDATE contacts SET display_name = NULL, username = NULL WHERE id = ${world.contactId}`;
    const net = network();
    await run(world);
    const text = String(net.telegram.find((request) => request.url.endsWith('/sendMessage'))?.body.text);
    expect(text).toContain('****3456');
    expect(text).not.toContain('256700123456');
  });

  it('stays silent on the phone when the owner switched Telegram off (the dashboard still offers Cancel)', async () => {
    const world = await seedAutopilotWorld(sql());
    await sql()`UPDATE settings SET notify_telegram = false`;
    const net = network();
    expect((await run(world)).kind).toBe('scheduled');
    expect(net.telegram).toHaveLength(0);
    expect((await draft(world.draftId)).status).toBe('scheduled');
  });
});

describe('the verifier has the last word', () => {
  it('a "fail" verdict routes the draft to approval and records what it found', async () => {
    const world = await seedAutopilotWorld(sql());
    network(() => verdict({ verdict: 'fail', unsupportedClaims: ['open on Sundays'] }));
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['verifier_failed'] });
    const row = await draft(world.draftId);
    expect(row.status).toBe('pending');
    expect(row.scheduled_send_at).toBeNull();
    expect(row.autopilot_decision).toMatchObject({ eligible: false, reasons: ['verifier_failed'], verifier: { verdict: 'fail', unsupportedClaims: ['open on Sundays'] } });
    expect(await job(world.draftId)).toBeUndefined();
  });

  it('a "pass" verdict that lists a commitment is a failure all the same', async () => {
    const world = await seedAutopilotWorld(sql());
    network(() => verdict({ verdict: 'pass', commitments: ['deliver tomorrow'] }));
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['verifier_failed'] });
  });

  it('a verifier that errors (the provider is down) routes to approval: an error is never a pass', async () => {
    const world = await seedAutopilotWorld(sql());
    network(() => new Response('{}', { status: 503 }));
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['verifier_error'] });
    expect((await draft(world.draftId)).status).toBe('pending');
    expect(await job(world.draftId)).toBeUndefined();
  });

  it('a verifier that answers nonsense routes to approval too', async () => {
    const world = await seedAutopilotWorld(sql());
    network(() => chatCompletion('looks fine to me'));
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['verifier_error'] });
  });
});

describe('the rules route to approval WITHOUT asking the verifier', () => {
  const cases: Array<[string, Parameters<typeof seedAutopilotWorld>[1], (world: World) => Promise<void> | void, string[]]> = [
    ['the eligibility gate fails (no evaluation, no track record)', { gate: false }, () => undefined, ['gate_failed']],
    ['autopilot is paused', { paused: true }, () => undefined, ['autopilot_paused']],
    ['a risk flag', { riskFlags: ['money_or_commitment'] }, () => undefined, ['risk_flags']],
    ['a missing fact', { missingFacts: ['delivery fee'] }, () => undefined, ['missing_facts']],
    ['a placeholder in the reply', { content: 'Delivery is [[fee?]]' }, () => undefined, ['placeholder']],
    ['an intent that is not allowed (order)', { intent: 'order' }, () => undefined, ['intent_not_allowed']],
    ['the window closing within 10 minutes', { windowHours: 0.1 }, () => undefined, ['window_closing']],
    ['fewer than three messages from the owner', { ownerMessages: 2 }, () => undefined, ['few_owner_messages']],
  ];

  it.each(cases)('%s', async (_name, options, change, reasons) => {
    const world = await seedAutopilotWorld(sql(), options);
    await change(world);
    const net = network();
    expect(await run(world)).toEqual({ kind: 'routed', reasons });
    expect(verifierCalls(net)).toHaveLength(0);
    const row = await draft(world.draftId);
    expect(row.status).toBe('pending');
    expect(row.autopilot_decision).toMatchObject({ eligible: false, reasons, verifier: null });
    expect(await job(world.draftId)).toBeUndefined();
    expect(net.telegram.filter((request) => request.url.endsWith('/sendMessage'))).toHaveLength(0);
  });

  it('quiet hours (23:30 in Kampala)', async () => {
    const world = await seedAutopilotWorld(sql(), { windowHours: 30 });
    const net = network();
    const outcome = await run(world, new Date('2026-10-04T20:30:00Z'));
    expect(outcome).toEqual({ kind: 'routed', reasons: ['quiet_hours'] });
    expect(verifierCalls(net)).toHaveLength(0);
  });

  it('this conversation already had its automatic replies this hour', async () => {
    const world = await seedAutopilotWorld(sql());
    for (let i = 0; i < 3; i += 1) await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(NOW.getTime() - (10 + i) * MIN) });
    network();
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['rate_limit_conversation'] });
  });

  it('the whole system\'s automatic replies for today are used up (counted in the owner\'s calendar day)', async () => {
    const world = await seedAutopilotWorld(sql());
    await sql()`UPDATE settings SET autopilot_max_per_day = 2`;
    const other = await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(NOW.getTime() - 2 * 60 * MIN) });
    await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(NOW.getTime() - 3 * 60 * MIN) });
    // Yesterday (Kampala) does not count: this one is 30 hours old.
    await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'ai_autopilot', occurredAt: new Date(NOW.getTime() - 30 * 60 * MIN) });
    expect(other).toBeTruthy();
    network();
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['rate_limit_daily'] });
    await sql()`UPDATE settings SET autopilot_max_per_day = 3`;
    await sql()`UPDATE drafts SET autopilot_decision = NULL WHERE id = ${world.draftId}`;
    expect((await run(world)).kind).toBe('scheduled');
  });

  it('too many automatic replies in a row', async () => {
    const world = await seedAutopilotWorld(sql());
    await sql()`UPDATE conversations SET consecutive_auto_replies = 4 WHERE id = ${world.conversationId}`;
    network();
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['consecutive_cap'] });
  });

  it('three customer messages each within seconds of ours look like another bot', async () => {
    const world = await seedAutopilotWorld(sql());
    // Replace the history with a tight ping-pong: we write, they answer 2 seconds later, three times.
    await sql()`DELETE FROM messages WHERE conversation_id = ${world.conversationId} AND id <> ${world.questionId}`;
    for (let i = 0; i < 4; i += 1) {
      const at = new Date(NOW.getTime() - (60 - i * 10) * MIN);
      await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'owner_manual', occurredAt: at });
      if (i > 0) await seedMessage(sql(), world.conversationId, { direction: 'inbound', occurredAt: new Date(at.getTime() + 2000) });
    }
    await sql()`UPDATE messages SET occurred_at = ${new Date(NOW.getTime() - 5 * MIN)} WHERE id = ${world.questionId}`;
    await seedMessage(sql(), world.conversationId, { direction: 'outbound', provenance: 'owner_manual', occurredAt: new Date(NOW.getTime() - 5 * MIN - 1500) });
    network();
    const outcome = await run(world);
    expect(outcome.kind).toBe('routed');
    expect(outcome.kind === 'routed' ? outcome.reasons : []).toContain('likely_bot');
  });

  it('a voice note: its machine transcript is never answered unseen', async () => {
    const world = await seedAutopilotWorld(sql());
    await sql()`UPDATE messages SET type = 'audio', content_source = 'transcript' WHERE id = ${world.questionId}`;
    network();
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['transcript_trigger'] });
  });
});

describe('"ok" and "thanks"', () => {
  it('an autopilot conversation stays silent: the draft is closed as rejected (reason no_reply_needed, actor autopilot), nobody is bothered', async () => {
    const world = await seedAutopilotWorld(sql(), { noReplyNeeded: true, content: 'You are welcome 🙏' });
    const net = network();
    expect(await run(world)).toEqual({ kind: 'closed_no_reply' });
    expect((await draft(world.draftId)).status).toBe('rejected');
    expect((await draft(world.draftId)).autopilot_decision).toMatchObject({ eligible: false, reasons: ['no_reply_needed'] });
    expect(await audits('draft.reject')).toEqual([{ actor: 'autopilot', entity_id: world.draftId, metadata: { conversationId: world.conversationId, reason: 'no_reply_needed' } }]);
    expect(net.groq).toHaveLength(0);
    expect(net.telegram).toHaveLength(0);
    expect(await count(sql(), 'messages', `direction = 'outbound' AND provenance = 'ai_autopilot'`)).toBe(0);
  });

  it('is NOT closed when autopilot is paused: a paused autopilot does nothing at all, the draft just waits as it always did', async () => {
    const world = await seedAutopilotWorld(sql(), { noReplyNeeded: true, paused: true });
    network();
    const outcome = await run(world);
    expect(outcome.kind).toBe('routed');
    expect((await draft(world.draftId)).status).toBe('pending');
  });
});

describe('demotion (spec 10.3)', () => {
  it.each([
    ['a complaint', { intent: 'complaint' }, 'complaint'],
    ['a request for a person', { intent: 'asks_for_human' }, 'asks_for_human'],
    ['an angry customer (risk flag)', { riskFlags: ['angry_customer'] }, 'angry_customer'],
    ['a complaint flagged as a risk', { riskFlags: ['complaint'] }, 'complaint'],
  ])('%s takes the conversation back to approval mode, tells the owner and audits it', async (_name, options, reason) => {
    const world = await seedAutopilotWorld(sql(), options);
    const net = network();
    const outcome = await run(world);
    expect(outcome.kind).toBe('routed');
    const [conversation] = await sql()<{ reply_mode: string; autopilot_until: Date | null }[]>`SELECT reply_mode, autopilot_until FROM conversations WHERE id = ${world.conversationId}`;
    expect(conversation?.reply_mode).toBe('approval');
    expect(await audits('autopilot.demote')).toEqual([{ actor: 'autopilot', entity_id: world.draftId, metadata: { conversationId: world.conversationId, reason } }]);
    const [alert] = await sql()<{ kind: string }[]>`SELECT kind FROM notifications WHERE dedupe_key = ${`autopilot_demoted:${world.draftId}`}`;
    expect(alert?.kind).toBe('alert:autopilot_demoted');
    expect(net.groq).toHaveLength(0); // never asks the verifier about a conversation that needs a person
    expect((await draft(world.draftId)).status).toBe('pending');
  });

  it('an ordinary question demotes nobody', async () => {
    const world = await seedAutopilotWorld(sql());
    network();
    await run(world);
    const [conversation] = await sql()<{ reply_mode: string }[]>`SELECT reply_mode FROM conversations WHERE id = ${world.conversationId}`;
    expect(conversation?.reply_mode).toBe('autopilot');
    expect(await audits('autopilot.demote')).toHaveLength(0);
  });
});

describe('races while the verifier thinks', () => {
  it('a customer message that arrives meanwhile supersedes the draft: nothing is scheduled', async () => {
    const world = await seedAutopilotWorld(sql());
    network((request) => {
      void request;
      return verdict();
    });
    // The verifier call is made while the customer writes again: simulate by making the "network" insert the message and supersede the draft.
    vi.unstubAllGlobals();
    stubNetwork({
      telegram: telegramOk,
      groq: async () => {
        await seedMessage(sql(), world.conversationId, { direction: 'inbound', content: 'also, do you deliver?', occurredAt: new Date(NOW.getTime() - 1000) });
        await sql()`UPDATE drafts SET status = 'superseded' WHERE id = ${world.draftId}`;
        return verdict();
      },
    });
    expect((await run(world)).kind).toBe('not_applicable');
    expect((await draft(world.draftId)).status).toBe('superseded');
    expect(await job(world.draftId)).toBeUndefined();
  });

  it('a customer message that arrives meanwhile but did not supersede yet still blocks the schedule (the draft is stale)', async () => {
    const world = await seedAutopilotWorld(sql());
    stubNetwork({
      telegram: telegramOk,
      groq: async () => {
        await seedMessage(sql(), world.conversationId, { direction: 'inbound', content: 'also, do you deliver?', occurredAt: new Date(NOW.getTime() - 1000) });
        return verdict();
      },
    });
    expect((await run(world)).kind).toBe('not_applicable');
    expect((await draft(world.draftId)).status).toBe('pending');
    expect(await job(world.draftId)).toBeUndefined();
  });
});

describe('after the model drafts (generate-draft)', () => {
  async function conversationNeedingADraft() {
    const world = await seedAutopilotWorld(sql());
    await sql()`DELETE FROM drafts WHERE id = ${world.draftId}`;
    return world;
  }

  it('a draft that gets scheduled is NOT also announced as "ready for approval": the owner gets the one autopilot message', async () => {
    const world = await conversationNeedingADraft();
    const net = stubNetwork({ telegram: telegramOk, groq: (request) => ((request.body?.model as string) === 'test-verify-model' ? verdict() : draftAnswer()) });
    const result = await generateDraftForConversation(world.conversationId, { finalAttempt: false, now: NOW });
    expect(result.outcome).toBe('created');
    const sent = net.telegram.filter((request) => request.url.endsWith('/sendMessage'));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.body.text)).toContain('Autopilot will reply');
    expect(String(sent[0]?.body.text)).not.toContain('ready for your approval');
    expect((await draft(result.draftId ?? '')).status).toBe('scheduled');
  });

  it('a draft routed to approval is announced the ordinary way', async () => {
    const world = await conversationNeedingADraft();
    const net = stubNetwork({ telegram: telegramOk, groq: (request) => ((request.body?.model as string) === 'test-verify-model' ? verdict({ verdict: 'fail', commitments: ['x'] }) : draftAnswer()) });
    const result = await generateDraftForConversation(world.conversationId, { finalAttempt: false, now: NOW });
    expect(result.outcome).toBe('created');
    const sent = net.telegram.filter((request) => request.url.endsWith('/sendMessage'));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.body.text)).toContain('ready for your approval');
    expect((await draft(result.draftId ?? '')).status).toBe('pending');
  });

  it('an autopilot failure never costs the owner the draft: the draft stays pending and the ordinary ping goes out', async () => {
    const world = await conversationNeedingADraft();
    // Break the eligibility query (the gate reads eval_runs) the nastiest way available: rename the table for the duration of the call.
    await sql().unsafe('ALTER TABLE eval_runs RENAME TO eval_runs_away');
    try {
      const net = stubNetwork({ telegram: telegramOk, groq: () => draftAnswer() });
      const result = await generateDraftForConversation(world.conversationId, { finalAttempt: false, now: NOW });
      expect(result.outcome).toBe('created');
      expect((await draft(result.draftId ?? '')).status).toBe('pending');
      expect(String(net.telegram.find((request) => request.url.endsWith('/sendMessage'))?.body.text)).toContain('ready for your approval');
    } finally {
      await sql().unsafe('ALTER TABLE eval_runs_away RENAME TO eval_runs');
    }
  });

  it('in approval mode drafting works exactly as before (no verifier, the ordinary ping)', async () => {
    const world = await seedAutopilotWorld(sql(), { replyMode: 'approval' });
    await sql()`DELETE FROM drafts WHERE id = ${world.draftId}`;
    const net = stubNetwork({ telegram: telegramOk, groq: () => draftAnswer() });
    const result = await generateDraftForConversation(world.conversationId, { finalAttempt: false, now: NOW });
    expect(result.outcome).toBe('created');
    expect(net.groq.filter((request) => (request.body?.model as string) === 'test-verify-model')).toHaveLength(0);
    expect(String(net.telegram.find((request) => request.url.endsWith('/sendMessage'))?.body.text)).toContain('ready for your approval');
  });
});


// ------------------------------------------------------------------------------------------------------ added after the mutation run
// Each of these closes a mutant that survived: the behaviour was real, nothing was watching it.

describe('a draft that is not pending is not the autopilot\'s business', () => {
  it('a rejected draft of a complaint neither asks the verifier nor takes the conversation off autopilot', async () => {
    const world = await seedAutopilotWorld(sql(), { intent: 'complaint' });
    await sql()`UPDATE drafts SET status = 'rejected' WHERE id = ${world.draftId}`;
    const net = network();
    expect(await run(world)).toEqual({ kind: 'not_applicable' });
    expect(net.groq).toHaveLength(0);
    const [conversation] = await sql()<{ reply_mode: string }[]>`SELECT reply_mode FROM conversations WHERE id = ${world.conversationId}`;
    expect(conversation?.reply_mode).toBe('autopilot');
    expect(await audits('autopilot.demote')).toHaveLength(0);
  });
});

describe('"ok" and "thanks": only genuine autopilot stays silent', () => {
  it('an "ok" that is also a complaint goes to the owner and demotes the conversation: it is not closed unseen', async () => {
    const world = await seedAutopilotWorld(sql(), { noReplyNeeded: true, intent: 'complaint' });
    network();
    const outcome = await run(world);
    expect(outcome.kind).toBe('routed');
    expect((await draft(world.draftId)).status).toBe('pending');
    const [conversation] = await sql()<{ reply_mode: string }[]>`SELECT reply_mode FROM conversations WHERE id = ${world.conversationId}`;
    expect(conversation?.reply_mode).toBe('approval');
  });

  it('is NOT closed when the autopilot period of the conversation has ended: it waits for the owner, who is told why', async () => {
    const world = await seedAutopilotWorld(sql(), { noReplyNeeded: true });
    await sql()`UPDATE conversations SET autopilot_until = ${new Date(NOW.getTime() - MIN)} WHERE id = ${world.conversationId}`;
    network();
    const outcome = await run(world);
    expect(outcome.kind).toBe('routed');
    expect(outcome.kind === 'routed' ? outcome.reasons : []).toContain('autopilot_expired');
    expect((await draft(world.draftId)).status).toBe('pending');
  });
});

describe('everything is asked again when the verifier comes back', () => {
  /** The verifier call takes seconds in real life. `during` runs while it "thinks" (the fake provider's handler), then the verdict is returned. */
  function whileVerifying(during: () => Promise<void>, answer: () => Response = () => verdict()) {
    return stubNetwork({
      telegram: telegramOk,
      groq: async () => {
        await during();
        return answer();
      },
    });
  }

  it('the owner switched the conversation back to approval meanwhile: not scheduled, routed with the reason, no countdown, no phone message', async () => {
    const world = await seedAutopilotWorld(sql());
    const net = whileVerifying(async () => {
      await sql()`UPDATE conversations SET reply_mode = 'approval' WHERE id = ${world.conversationId}`;
    });
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['not_autopilot_mode'] });
    const row = await draft(world.draftId);
    expect(row.status).toBe('pending');
    expect(row.autopilot_decision).toMatchObject({ eligible: false, reasons: ['not_autopilot_mode'] });
    expect(await job(world.draftId)).toBeUndefined();
    expect(net.telegram.filter((request) => request.url.endsWith('/sendMessage'))).toHaveLength(0);
  });

  it('autopilot was paused meanwhile: not scheduled', async () => {
    const world = await seedAutopilotWorld(sql());
    whileVerifying(async () => {
      await sql()`UPDATE settings SET autopilot_paused = true`;
    });
    expect(await run(world)).toEqual({ kind: 'routed', reasons: ['autopilot_paused'] });
    expect((await draft(world.draftId)).status).toBe('pending');
  });

  it('the owner rejected the draft meanwhile and the verifier then fails it: the owner\'s decision stands and no autopilot decision is written over it', async () => {
    const world = await seedAutopilotWorld(sql());
    whileVerifying(
      async () => {
        await sql()`UPDATE drafts SET status = 'rejected' WHERE id = ${world.draftId}`;
      },
      () => verdict({ verdict: 'fail', unsupportedClaims: ['x'] }),
    );
    await run(world);
    const row = await draft(world.draftId);
    expect(row.status).toBe('rejected');
    expect(row.autopilot_decision).toBeNull();
  });

  it('the owner rejected the draft meanwhile and the verifier passes it: it is NOT scheduled', async () => {
    const world = await seedAutopilotWorld(sql());
    whileVerifying(async () => {
      await sql()`UPDATE drafts SET status = 'rejected' WHERE id = ${world.draftId}`;
    });
    expect(await run(world)).toEqual({ kind: 'not_applicable' });
    expect((await draft(world.draftId)).status).toBe('rejected');
    expect(await job(world.draftId)).toBeUndefined();
    expect(await audits('autopilot.schedule')).toHaveLength(0);
  });
});
