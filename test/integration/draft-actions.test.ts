import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getDraftDetail, getIntentStats, listApprovalQueue, countOpenDrafts } from '@/lib/drafts/queries';
import { editDistance } from '@/lib/metrics/edit-distance';
import { createEnrolledOwner, headersWith } from '../helpers/auth';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, T0, count, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';
import { createTestRedis } from '../helpers/redis';

// The real server actions read their headers through next/headers; point it at a mutable test cookie.
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { approveDraft, regenerateDraft, rejectDraft, requestDraft } = await import('@/actions/drafts');

const h = setupIngestHarness();
const sql = () => h.admin();

let sendQueue: Queue;
let draftQueue: Queue;
beforeAll(() => {
  sendQueue = new Queue('outbound-send', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
  draftQueue = new Queue('generate-draft', { connection: createTestRedis(), prefix: getEnv().BULLMQ_PREFIX });
});
afterAll(async () => {
  for (const queue of [sendQueue, draftQueue]) {
    await queue.obliterate({ force: true });
    await queue.close();
  }
});
beforeEach(async () => {
  await sendQueue.obliterate({ force: true });
  await draftQueue.obliterate({ force: true });
  requestHeaders.current = new Headers();
});
afterEach(() => vi.unstubAllGlobals());

async function signedIn(): Promise<void> {
  const owner = await createEnrolledOwner();
  requestHeaders.current = headersWith(owner.cookie);
}

const MIN = 60 * 1000;
// The actions evaluate the 24h window at the real clock (the owner presses the button "now"), so conversations here are open relative to it.
const openWindow = () => new Date(Date.now() + 5 * HOUR);
const key = (n: string) => `draft-key-${n}-0123456789`;

interface Seeded {
  conversationId: string;
  triggerId: string;
}

async function customer(o: { window?: Date | null; waiting?: boolean; ai?: 'on' | 'paused' } = {}): Promise<Seeded> {
  const aiPaused = o.ai === 'paused';
  await sql()`
    INSERT INTO settings (id, owner_name, business_name, ai_paused, sending_paused) VALUES (1, 'Marvin', 'agent_47', ${aiPaused}, false)
    ON CONFLICT (id) DO UPDATE SET ai_paused = ${aiPaused}, sending_paused = false`;
  const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid, name: 'Amina' });
  const conversationId = await seedConversation(sql(), contact, { status: o.waiting === false ? 'waiting_on_customer' : 'waiting_on_me' });
  const triggerId = await seedMessage(sql(), conversationId, { direction: 'inbound', content: 'Do you have the blue dress in M?', occurredAt: T0 });
  const window = o.window === undefined ? openWindow() : o.window;
  await sql()`UPDATE conversations SET last_inbound_at = ${T0}, last_message_at = ${T0}, window_expires_at = ${window} WHERE id = ${conversationId}`;
  return { conversationId, triggerId };
}

interface DraftOptions {
  status?: string;
  content?: string;
  original?: string;
  intent?: string;
  triggers?: string[];
  createdAt?: Date;
  editDistance?: number | null;
  noReplyNeeded?: boolean;
  fewshot?: string[];
  riskFlags?: string[];
  missingFacts?: string[];
}

async function makeDraft(conversationId: string, o: DraftOptions = {}): Promise<string> {
  const content = o.content ?? 'Yes dear, we have it 🙏';
  const [row] = await sql()<{ id: string }[]>`
    INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status,
                        created_at, edit_distance, no_reply_needed, fewshot_message_ids, risk_flags, missing_facts, style_guide_version)
    VALUES (gen_random_uuid(), ${conversationId}, ${sql().array(o.triggers ?? [])}::uuid[], ${content}, ${o.original ?? content},
            ${o.intent ?? 'question'}::draft_intent, 'Asks about the dress.', 'm', 'draft-v1', ${o.status ?? 'pending'}::draft_status,
            ${o.createdAt ?? NOW}, ${o.editDistance ?? null}, ${o.noReplyNeeded ?? false}, ${sql().array(o.fewshot ?? [])}::uuid[],
            ${sql().array(o.riskFlags ?? [])}::text[], ${sql().array(o.missingFacts ?? [])}::text[], 3)
    RETURNING id`;
  if (!row) throw new Error('makeDraft failed');
  return row.id;
}

const draftRow = async (id: string) => (await sql()<{ status: string; content: string; edit_distance: number | null; final_message_id: string | null }[]>`SELECT status, content, edit_distance, final_message_id FROM drafts WHERE id = ${id}`)[0];
const outbound = () => sql()<{ id: string; provenance: string; status: string; content: string }[]>`SELECT id, provenance, status, content FROM messages WHERE direction = 'outbound' ORDER BY occurred_at`;
const audit = () => sql()<{ action: string; entity_id: string; metadata: Record<string, unknown> }[]>`SELECT action, entity_id, metadata FROM audit_log WHERE actor = 'owner' ORDER BY created_at`;

describe('approveDraft (the real server action)', () => {
  it('is rejected without a session and sends nothing', async () => {
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    expect(await approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key('a') })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await outbound()).toHaveLength(0);
    expect((await draftRow(draftId))?.status).toBe('pending');
  });

  it('approving as written is `ai_unedited`: draft approved, distance 0, one send job, an audit entry WITHOUT the text, and a dashboard event', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId], content: 'Yes dear, we have it 🙏' });
    const result = await approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key('a') });

    expect(result).toMatchObject({ ok: true, data: { conversationId, edited: false, duplicate: false } });
    if (!result.ok) return;
    expect(await outbound()).toEqual([{ id: result.data.messageId, provenance: 'ai_unedited', status: 'queued', content: 'Yes dear, we have it 🙏' }]);
    expect(await draftRow(draftId)).toMatchObject({ status: 'approved', edit_distance: 0, final_message_id: result.data.messageId });
    expect((await sendQueue.getJobs(['waiting'])).map((job) => job.id)).toEqual([`send%3A${result.data.messageId}`]);

    const entries = (await audit()).filter((e) => e.action.startsWith('draft.'));
    expect(entries).toEqual([{ action: 'draft.approve', entity_id: draftId, metadata: expect.objectContaining({ messageId: result.data.messageId, editDistance: 0, overrideStale: false }) }]);
    expect(JSON.stringify(entries)).not.toContain('blue dress');
    expect(JSON.stringify(entries)).not.toContain('we have it');
    const events = (await h.events()).filter((e) => e.type === 'draft:updated');
    expect(events).toEqual([expect.objectContaining({ payload: { conversationId, draftId, status: 'approved' } })]);
  });

  it('approving an EDITED text is `ai_edited`: the draft keeps the original, the message has the edit, and the distance is stored', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const original = 'Yes dear, we have it 🙏';
    const draftId = await makeDraft(conversationId, { triggers: [triggerId], content: original });
    const edited = 'Yes, we have it in M. Come anytime 🙏';
    const result = await approveDraft({ draftId, text: edited, idempotencyKey: key('e') });

    expect(result).toMatchObject({ ok: true, data: { edited: true } });
    expect((await outbound())[0]).toMatchObject({ provenance: 'ai_edited', content: edited });
    const stored = await sql()<{ status: string; content: string; original_content: string; edit_distance: number }[]>`SELECT status, content, original_content, edit_distance FROM drafts WHERE id = ${draftId}`;
    expect(stored[0]).toMatchObject({ status: 'edited', content: edited, original_content: original });
    expect(stored[0]?.edit_distance).toBeCloseTo(editDistance(original, edited), 4);
    expect(stored[0]?.edit_distance).toBeGreaterThan(0);
    expect((await audit()).filter((e) => e.action.startsWith('draft.')).map((e) => e.action)).toEqual(['draft.approve_edited']);
    expect(JSON.stringify(await audit())).not.toContain('Come anytime');
  });

  it('whitespace around the text is not an edit: provenance, draft status, audit action and the answer all agree', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId], content: 'Yes dear, we have it 🙏' });
    const result = await approveDraft({ draftId, text: '  Yes dear, we have it 🙏\n\n', idempotencyKey: key('ws') });

    expect(result).toMatchObject({ ok: true, data: { edited: false } });
    expect((await outbound())[0]?.provenance).toBe('ai_unedited');
    expect(await draftRow(draftId)).toMatchObject({ status: 'approved', edit_distance: 0 });
    expect((await audit()).map((e) => e.action)).toContain('draft.approve');
    expect((await audit()).map((e) => e.action)).not.toContain('draft.approve_edited');
  });

  it('a [[placeholder]] BLOCKS the send: refused with a reason, the draft stays pending, nothing is written; replacing it then sends as `ai_edited`', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId], content: 'The price is [[price]]' });

    const blocked = await approveDraft({ draftId, text: 'The price is [[price]]', idempotencyKey: key('ph1') });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'refused', reason: 'placeholder_unresolved' } });
    expect(await outbound()).toHaveLength(0);
    expect((await draftRow(draftId))?.status).toBe('pending');
    expect((await audit()).filter((e) => e.action.startsWith('draft.'))).toHaveLength(0);
    expect(await sendQueue.getJobs(['waiting'])).toHaveLength(0);

    const fixed = await approveDraft({ draftId, text: 'The price is UGX 50,000', idempotencyKey: key('ph2') });
    expect(fixed).toMatchObject({ ok: true, data: { edited: true } });
    expect((await outbound())[0]).toMatchObject({ provenance: 'ai_edited', content: 'The price is UGX 50,000' });
  });

  it('a draft the customer has written past is STALE: refused as `draft_stale`; "send anyway" sends it and records the override', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    await seedMessage(sql(), conversationId, { direction: 'inbound', content: 'actually the red one', occurredAt: new Date(T0.getTime() + 2 * MIN) });

    const refused = await approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key('s1') });
    expect(refused).toMatchObject({ ok: false, error: { code: 'refused', reason: 'draft_stale' } });
    expect(await outbound()).toHaveLength(0);
    expect((await draftRow(draftId))?.status).toBe('pending');

    const sent = await approveDraft({ draftId, text: 'Yes dear, we have it 🙏', overrideStale: true, idempotencyKey: key('s2') });
    expect(sent).toMatchObject({ ok: true });
    expect((await outbound())[0]?.provenance).toBe('ai_unedited');
    expect((await audit()).find((e) => e.action === 'draft.approve')?.metadata).toMatchObject({ overrideStale: true });
  });

  it('a double submit with the same key is one message and one job (and the draft is not rewritten)', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    const submit = () => approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key('dup') });
    const [a, b] = await Promise.all([submit(), submit()]);

    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    if (!a.ok || !b.ok) return;
    expect(a.data.messageId).toBe(b.data.messageId);
    expect([a.data.duplicate, b.data.duplicate].sort()).toEqual([false, true]);
    expect(await outbound()).toHaveLength(1);
    expect(await sendQueue.getJobs(['waiting'])).toHaveLength(1);
  });

  it('two DIFFERENT submissions racing for one draft: exactly one wins, the other is told it was already handled', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    const results = await Promise.all([
      approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key('r1') }),
      approveDraft({ draftId, text: 'A different answer', idempotencyKey: key('r2') }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'refused', reason: 'draft_not_open' } });
    expect(await outbound()).toHaveLength(1);
    expect(await sendQueue.getJobs(['waiting'])).toHaveLength(1);
  });

  it.each(['approved', 'edited', 'rejected', 'superseded', 'failed', 'cancelled'])('a %s draft cannot be approved', async (status) => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId], status });
    expect(await approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key(`s-${status}`) })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'draft_not_open' } });
    expect(await outbound()).toHaveLength(0);
  });

  it('a draft that does not exist is refused, not crashed on', async () => {
    await signedIn();
    expect(await approveDraft({ draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'hi', idempotencyKey: key('nf') })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'draft_not_open' } });
  });

  it('is refused when the 24h window has closed, and the draft stays pending', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer({ window: new Date(Date.now() - HOUR) });
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    expect(await approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key('w') })).toMatchObject({ ok: false, error: { reason: 'window_closed' } });
    expect((await draftRow(draftId))?.status).toBe('pending');
  });

  it('is refused while sending is paused', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    await sql()`UPDATE settings SET sending_paused = true`;
    expect(await approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key('p') })).toMatchObject({ ok: false, error: { reason: 'sending_paused' } });
    expect((await draftRow(draftId))?.status).toBe('pending');
  });

  it('refuses an empty text (clearing the box is not an approval) and a no-reply draft whose content is empty', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId], content: '', noReplyNeeded: true });
    expect(await approveDraft({ draftId, text: '   ', idempotencyKey: key('em') })).toMatchObject({ ok: false, error: { reason: 'empty_message' } });
    expect(await outbound()).toHaveLength(0);
  });

  it('approving supersedes every other open draft of the conversation (belt and braces: the customer has been answered)', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const keep = await makeDraft(conversationId, { triggers: [triggerId] });
    const other = await makeDraft(conversationId, { triggers: [triggerId], content: 'another take' });
    expect(await approveDraft({ draftId: keep, text: 'Yes dear, we have it 🙏', idempotencyKey: key('ss') })).toMatchObject({ ok: true });
    expect((await draftRow(keep))?.status).toBe('approved');
    expect((await draftRow(other))?.status).toBe('superseded');
  });

  it.each([
    ['a non-uuid draft id', { draftId: 'nope', text: 'hi', idempotencyKey: key('v1') }],
    ['no text field', { draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', idempotencyKey: key('v2') }],
    ['no idempotency key', { draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'hi' }],
    ['a short idempotency key', { draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'hi', idempotencyKey: 'short' }],
    ['absurdly long text', { draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'x'.repeat(20_001), idempotencyKey: key('v3') }],
    ['a non-boolean override', { draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', text: 'hi', overrideStale: 'yes', idempotencyKey: key('v4') }],
  ])('validates input: %s', async (_name, input) => {
    await signedIn();
    expect(await approveDraft(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});

describe('rejectDraft', () => {
  it('is owner-only', async () => {
    const { conversationId } = await customer();
    const draftId = await makeDraft(conversationId);
    expect(await rejectDraft({ draftId })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect((await draftRow(draftId))?.status).toBe('pending');
  });

  it('pending -> rejected with an audit entry and an event; the customer stays waiting; nothing is sent', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    expect(await rejectDraft({ draftId })).toMatchObject({ ok: true, data: { conversationId } });
    expect((await draftRow(draftId))?.status).toBe('rejected');
    expect((await audit()).map((e) => e.action)).toEqual(['draft.reject']);
    expect((await h.events()).filter((e) => e.type === 'draft:updated')).toEqual([expect.objectContaining({ payload: { conversationId, draftId, status: 'rejected' } })]);
    expect(await outbound()).toHaveLength(0);
    expect((await sql()<{ status: string }[]>`SELECT status FROM conversations WHERE id = ${conversationId}`)[0]?.status).toBe('waiting_on_me');
  });

  it('a scheduled draft can be rejected too? NO: only pending (the autopilot cancel path owns scheduled), and the refusal changes nothing', async () => {
    await signedIn();
    const { conversationId } = await customer();
    const draftId = await makeDraft(conversationId, { status: 'scheduled' });
    const result = await rejectDraft({ draftId });
    // The state machine has no reject arrow out of `scheduled`: the owner cancels the scheduled send first (Phase 7).
    expect(result).toMatchObject({ ok: false, error: { code: 'refused', reason: 'draft_not_open' } });
    expect((await draftRow(draftId))?.status).toBe('scheduled');
  });

  it.each(['approved', 'edited', 'rejected', 'superseded', 'failed'])('a %s draft cannot be rejected, and a second click is refused', async (status) => {
    await signedIn();
    const { conversationId } = await customer();
    const draftId = await makeDraft(conversationId, { status });
    expect(await rejectDraft({ draftId })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'draft_not_open' } });
    expect((await draftRow(draftId))?.status).toBe(status);
    expect((await audit()).filter((e) => e.action === 'draft.reject')).toHaveLength(0);
  });

  it('a reject racing an approve: exactly one wins, and an approved draft is never also rejected', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    const [approved, rejected] = await Promise.all([approveDraft({ draftId, text: 'Yes dear, we have it 🙏', idempotencyKey: key('race') }), rejectDraft({ draftId })]);
    expect([approved.ok, rejected.ok].filter(Boolean)).toHaveLength(1);
    const status = (await draftRow(draftId))?.status;
    expect(status).toBe(approved.ok ? 'approved' : 'rejected');
    expect(await outbound()).toHaveLength(approved.ok ? 1 : 0);
  });
});

describe('regenerateDraft', () => {
  it('supersedes the open draft and queues an immediate, manual generation job', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    expect(await regenerateDraft({ draftId })).toMatchObject({ ok: true, data: { conversationId } });

    expect((await draftRow(draftId))?.status).toBe('superseded');
    const jobs = await draftQueue.getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ conversationId, manual: true });
    expect(jobs[0]?.opts.delay ?? 0).toBe(0);
    expect((await audit()).map((e) => e.action)).toEqual(['draft.regenerate']);
    expect((await h.events()).filter((e) => e.type === 'draft:updated')).toEqual([expect.objectContaining({ payload: { conversationId, draftId, status: 'superseded' } })]);
  });

  it('a FAILED draft is retried without being "superseded" (it stays as the record of what failed)', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId], status: 'failed', content: '' });
    expect(await regenerateDraft({ draftId })).toMatchObject({ ok: true });
    expect((await draftRow(draftId))?.status).toBe('failed');
    expect(await draftQueue.getJobs(['waiting', 'delayed', 'prioritized'])).toHaveLength(1);
  });

  it('a pending draft replaces a debounced job that was still waiting (one job per conversation, now)', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    await draftQueue.add('draft', { conversationId }, { delay: 60_000, deduplication: { id: `draft:${conversationId}`, ttl: 60_000, extend: true, replace: true } });
    expect(await regenerateDraft({ draftId })).toMatchObject({ ok: true });
    expect(await draftQueue.getDelayed()).toHaveLength(0);
    const jobs = await draftQueue.getJobs(['waiting', 'prioritized']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ manual: true });
  });

  it('is refused while AI drafting is paused, and the draft is left exactly as it was', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer({ ai: 'paused' });
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    expect(await regenerateDraft({ draftId })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'ai_paused' } });
    expect((await draftRow(draftId))?.status).toBe('pending');
    expect(await draftQueue.getJobs(['waiting', 'delayed', 'prioritized'])).toHaveLength(0);
    expect((await audit()).filter((e) => e.action === 'draft.regenerate')).toHaveLength(0);
  });

  it('is refused when the customer has already been answered, and the supersede is rolled back with it', async () => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    await seedMessage(sql(), conversationId, { direction: 'outbound', content: 'answered from my phone', provenance: 'owner_app_echo', occurredAt: new Date(T0.getTime() + MIN) });
    expect(await regenerateDraft({ draftId })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'nothing_to_answer' } });
    expect((await draftRow(draftId))?.status).toBe('pending');
    expect(await draftQueue.getJobs(['waiting', 'delayed', 'prioritized'])).toHaveLength(0);
  });

  it.each(['approved', 'edited', 'rejected', 'superseded'])('a %s draft cannot be regenerated', async (status) => {
    await signedIn();
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId], status });
    expect(await regenerateDraft({ draftId })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'draft_not_open' } });
    expect(await draftQueue.getJobs(['waiting', 'delayed', 'prioritized'])).toHaveLength(0);
  });

  it('an unknown draft is refused', async () => {
    await signedIn();
    expect(await regenerateDraft({ draftId: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'not_found' } });
  });

  it('is owner-only', async () => {
    const { conversationId } = await customer();
    const draftId = await makeDraft(conversationId);
    expect(await regenerateDraft({ draftId })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect((await draftRow(draftId))?.status).toBe('pending');
  });
});

describe('requestDraft ("Draft a reply")', () => {
  it('queues one immediate generation for a conversation with something unanswered', async () => {
    await signedIn();
    const { conversationId } = await customer();
    expect(await requestDraft({ conversationId })).toMatchObject({ ok: true, data: { conversationId } });
    const jobs = await draftQueue.getJobs(['waiting', 'prioritized', 'delayed']);
    expect(jobs.map((job) => job.data)).toEqual([{ conversationId, manual: true }]);
    expect((await audit()).map((e) => e.action)).toEqual(['draft.request']);
  });

  it('pressing it twice is still one job', async () => {
    await signedIn();
    const { conversationId } = await customer();
    await requestDraft({ conversationId });
    await requestDraft({ conversationId });
    expect(await draftQueue.getJobs(['waiting', 'prioritized', 'delayed'])).toHaveLength(1);
  });

  it('is refused while AI is paused, when there is nothing to answer, and for strangers', async () => {
    await signedIn();
    const paused = await customer({ ai: 'paused' });
    expect(await requestDraft({ conversationId: paused.conversationId })).toMatchObject({ ok: false, error: { reason: 'ai_paused' } });
    await sql()`UPDATE settings SET ai_paused = false`;
    await seedMessage(sql(), paused.conversationId, { direction: 'outbound', content: 'already replied', occurredAt: new Date(T0.getTime() + MIN) });
    expect(await requestDraft({ conversationId: paused.conversationId })).toMatchObject({ ok: false, error: { reason: 'nothing_to_answer' } });
    expect(await draftQueue.getJobs(['waiting', 'prioritized', 'delayed'])).toHaveLength(0);

    requestHeaders.current = new Headers();
    expect(await requestDraft({ conversationId: paused.conversationId })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });
});

describe('the approval queue and draft details', () => {
  it('lists open drafts oldest first, each with the customer, the first unanswered message on one line, and the intent', async () => {
    const { conversationId, triggerId } = await customer();
    const later = await makeDraft(conversationId, { triggers: [triggerId], createdAt: new Date(NOW.getTime() + 5 * MIN), intent: 'payment' });
    const earlier = await makeDraft(conversationId, { triggers: [triggerId], createdAt: new Date(NOW.getTime() - 5 * MIN), status: 'scheduled' });
    await makeDraft(conversationId, { triggers: [triggerId], status: 'approved' });
    await makeDraft(conversationId, { triggers: [triggerId], status: 'rejected' });
    await makeDraft(conversationId, { triggers: [triggerId], status: 'superseded' });

    const queue = await listApprovalQueue(getDb());
    expect(queue.map((item) => item.id)).toEqual([earlier, later]);
    expect(queue[0]).toMatchObject({ status: 'scheduled', name: 'Amina', conversationId, preview: 'Do you have the blue dress in M?', noReplyNeeded: false });
    expect(queue[1]).toMatchObject({ status: 'pending', intent: 'payment' });
  });

  it('a long multi-line first message is flattened and shortened for the preview', async () => {
    const { conversationId } = await customer();
    const long = await seedMessage(sql(), conversationId, { direction: 'inbound', content: `line one\nline two ${'x'.repeat(200)}`, occurredAt: T0 });
    await makeDraft(conversationId, { triggers: [long] });
    const [item] = await listApprovalQueue(getDb());
    expect(item?.preview).not.toContain('\n');
    expect(item?.preview.length).toBeLessThanOrEqual(82);
  });

  it('shows a FAILED draft only while the customer is still unanswered and nothing newer exists (so Regenerate is offered, and never nagged about later)', async () => {
    const a = await customer();
    const failed = await makeDraft(a.conversationId, { triggers: [a.triggerId], status: 'failed', content: '', createdAt: new Date(NOW.getTime() - 10 * MIN) });
    expect((await listApprovalQueue(getDb())).map((i) => i.id)).toEqual([failed]);

    // A newer open draft replaces it in the queue.
    const retry = await makeDraft(a.conversationId, { triggers: [a.triggerId], createdAt: new Date(NOW.getTime() - 5 * MIN) });
    expect((await listApprovalQueue(getDb())).map((i) => i.id)).toEqual([retry]);
    await sql()`UPDATE drafts SET status = 'rejected' WHERE id = ${retry}`;
    expect((await listApprovalQueue(getDb())).map((i) => i.id)).toEqual([failed]);

    // The owner answers by hand: the failure no longer matters.
    await seedMessage(sql(), a.conversationId, { direction: 'outbound', content: 'by hand', occurredAt: NOW });
    expect(await listApprovalQueue(getDb())).toEqual([]);
  });

  it('a failed draft of a conversation that is not waiting on the owner is not listed', async () => {
    const a = await customer({ waiting: false });
    await makeDraft(a.conversationId, { triggers: [a.triggerId], status: 'failed', content: '' });
    expect(await listApprovalQueue(getDb())).toEqual([]);
  });

  it('counts open drafts for the overview, leaving out the ones that need no reply', async () => {
    const { conversationId, triggerId } = await customer();
    await makeDraft(conversationId, { triggers: [triggerId] });
    await makeDraft(conversationId, { triggers: [triggerId], status: 'scheduled' });
    await makeDraft(conversationId, { triggers: [triggerId], noReplyNeeded: true, content: '' });
    await makeDraft(conversationId, { triggers: [triggerId], status: 'failed', content: '' });
    expect(await countOpenDrafts(getDb())).toBe(2);
  });

  it('intent stats: sent / edited / median edit distance over 90 days, for THIS intent only', async () => {
    const { conversationId, triggerId } = await customer();
    const make = (o: DraftOptions) => makeDraft(conversationId, { triggers: [triggerId], ...o });
    const day = 24 * HOUR;
    await make({ intent: 'payment', status: 'approved', editDistance: 0, createdAt: new Date(NOW.getTime() - 5 * day) });
    await make({ intent: 'payment', status: 'edited', editDistance: 0.2, createdAt: new Date(NOW.getTime() - 6 * day) });
    await make({ intent: 'payment', status: 'edited', editDistance: 0.6, createdAt: new Date(NOW.getTime() - 7 * day) });
    await make({ intent: 'payment', status: 'edited', editDistance: 0.9, createdAt: new Date(NOW.getTime() - 100 * day) }); // too old
    await make({ intent: 'payment', status: 'rejected', createdAt: new Date(NOW.getTime() - 5 * day) }); // not sent
    await make({ intent: 'chit_chat', status: 'edited', editDistance: 1, createdAt: new Date(NOW.getTime() - 5 * day) }); // other intent

    const stats = await getIntentStats(getDb(), 'payment', NOW);
    expect(stats).toMatchObject({ sent: 3, edited: 2 });
    expect(stats.medianEditDistance).toBeCloseTo(0.2, 5); // the column is a 4-byte real
    expect(await getIntentStats(getDb(), 'complaint', NOW)).toEqual({ sent: 0, edited: 0, medianEditDistance: null });
  });

  it('draft details carry everything the card shows, and `stale` only while the draft is open and the customer wrote after it', async () => {
    const { conversationId, triggerId } = await customer();
    const fewshot = [await seedMessage(sql(), conversationId, { direction: 'outbound', content: 'old reply', provenance: 'imported', occurredAt: new Date(T0.getTime() - 40 * 24 * HOUR) })];
    const draftId = await makeDraft(conversationId, {
      triggers: [triggerId],
      intent: 'payment',
      fewshot,
      riskFlags: ['mentions_money'],
      missingFacts: ['the price of the red dress'],
      content: 'It is [[price]]',
      original: 'It is [[price]]',
    });
    const fresh = await getDraftDetail(getDb(), draftId, NOW);
    expect(fresh).toMatchObject({
      id: draftId,
      status: 'pending',
      conversationId,
      name: 'Amina',
      intent: 'payment',
      content: 'It is [[price]]',
      riskFlags: ['mentions_money'],
      missingFacts: ['the price of the red dress'],
      fewshotCount: 1,
      styleGuideVersion: 3,
      triggerMessageIds: [triggerId],
      stale: false,
      stats: { sent: 0, edited: 0, medianEditDistance: null },
    });
    expect(fresh?.windowExpiresAt).toBeInstanceOf(Date);

    await seedMessage(sql(), conversationId, { direction: 'inbound', content: 'hello??', occurredAt: new Date(T0.getTime() + MIN) });
    expect((await getDraftDetail(getDb(), draftId, NOW))?.stale).toBe(true);
    await sql()`UPDATE drafts SET status = 'rejected' WHERE id = ${draftId}`;
    expect((await getDraftDetail(getDb(), draftId, NOW))?.stale).toBe(false);
  });

  it('a reaction or a deleted message after the draft does not make it stale', async () => {
    const { conversationId, triggerId } = await customer();
    const draftId = await makeDraft(conversationId, { triggers: [triggerId] });
    await seedMessage(sql(), conversationId, { direction: 'inbound', type: 'reaction', content: '👍', occurredAt: new Date(T0.getTime() + MIN) });
    const gone = await seedMessage(sql(), conversationId, { direction: 'inbound', content: 'oops', occurredAt: new Date(T0.getTime() + 2 * MIN) });
    await sql()`UPDATE messages SET deleted_at = now() WHERE id = ${gone}`;
    expect((await getDraftDetail(getDb(), draftId, NOW))?.stale).toBe(false);
  });

  it('an unknown id has no details', async () => {
    expect(await getDraftDetail(getDb(), '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', NOW)).toBeNull();
    expect(await count(sql(), 'drafts')).toBe(0);
  });
});
