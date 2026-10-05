import { describe, expect, it } from 'vitest';
import { countWaitingOnYou, getNeedsAttention } from '@/lib/dashboard/attention';
import { getDb } from '@/lib/db';
import { medianResponseTime } from '@/lib/metrics/response-time';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();
const MIN = 60 * 1000;
const DAY = 24 * HOUR;
const AT = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

let counter = 0;
async function conversation(name: string, status: 'open' | 'waiting_on_me' | 'waiting_on_customer' | 'resolved' = 'waiting_on_me'): Promise<string> {
  counter += 1;
  const contact = await seedContact(sql(), { phone: `+25670099${String(counter).padStart(4, '0')}`, bsuid: `UG.OV${counter}`, name });
  return seedConversation(sql(), contact, { status });
}

describe('getNeedsAttention', () => {
  it('lists every kind, worst first: failed messages, overdue tasks, closing windows, drafts waiting', async () => {
    const a = await conversation('Amina');
    const b = await conversation('Brian');
    const c = await conversation('Chloe');
    const d = await conversation('Dan');
    await sql()`INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING`;

    // a failed reply and an unknown one
    await seedMessage(sql(), a, { direction: 'outbound', status: 'failed', content: 'x', occurredAt: AT(-3 * HOUR) });
    await seedMessage(sql(), a, { direction: 'outbound', status: 'unknown', content: 'y', occurredAt: AT(-2 * HOUR) });
    // an overdue task
    await sql()`INSERT INTO tasks (id, conversation_id, description, type, due_at, created_by) VALUES (gen_random_uuid(), ${b}, 'Call Brian about delivery', 'followup', ${AT(-3 * HOUR)}, 'ai')`;
    // a window closing in 40 minutes with no reply
    await seedMessage(sql(), c, { direction: 'inbound', content: 'hello?', occurredAt: AT(-23 * HOUR - 20 * MIN) });
    await sql()`UPDATE conversations SET last_inbound_at = ${AT(-23 * HOUR - 20 * MIN)}, window_expires_at = ${AT(40 * MIN)} WHERE id = ${c}`;
    // a draft waiting 45 minutes
    const dm = await seedMessage(sql(), d, { direction: 'inbound', content: 'price?', occurredAt: AT(-50 * MIN) });
    const [draft] = await sql()<{ id: string }[]>`
      INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status, created_at)
      VALUES (gen_random_uuid(), ${d}, ${sql().array([dm])}::uuid[], 'x', 'x', 'question', 'a', 'm', 'p', 'pending', ${AT(-45 * MIN)}) RETURNING id`;

    const items = await getNeedsAttention(getDb(), NOW);
    expect(items.map((i) => i.kind)).toEqual(['message_problem', 'task_overdue', 'window_expiring', 'draft_waiting']);
    expect(items.map((i) => i.name)).toEqual(['Amina', 'Brian', 'Chloe', 'Dan']);
    expect(items[0]).toMatchObject({ detail: '2 replies need a look: some could not be sent, some may not have been sent.', href: `/conversations/${a}` });
    expect(items[1]).toMatchObject({ detail: 'Overdue: Call Brian about delivery', href: expect.stringContaining('/tasks') });
    expect(items[2]?.detail).toContain('closes in 40 min');
    expect(items[2]?.href).toBe(`/conversations/${c}`);
    expect(items[3]).toMatchObject({ detail: 'A draft has been waiting 45 min for your decision.', href: `/approvals?d=${draft?.id}` });
  });

  it('leaves out what is not a problem: recent drafts, "needs no reply" drafts, tasks that are done or not yet due, windows already answered or resolved, old failures', async () => {
    const a = await conversation('Amina');
    const b = await conversation('Brian', 'resolved');
    const c = await conversation('Chloe');
    const dm = await seedMessage(sql(), a, { direction: 'inbound', content: 'hi', occurredAt: AT(-20 * MIN) });
    const draftSql = (created: Date, noReply: boolean, status = 'pending') => sql()`
      INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status, no_reply_needed, created_at)
      VALUES (gen_random_uuid(), ${a}, ${sql().array([dm])}::uuid[], 'x', 'x', 'question', 'a', 'm', 'p', ${status}, ${noReply}, ${created})`;
    await draftSql(AT(-20 * MIN), false); // only 20 minutes
    await draftSql(AT(-2 * HOUR), true); // needs no reply
    await draftSql(AT(-2 * HOUR), false, 'rejected');
    await sql()`INSERT INTO tasks (id, conversation_id, description, type, due_at, created_by, status) VALUES (gen_random_uuid(), ${a}, 'done one', 'followup', ${AT(-HOUR)}, 'ai', 'done')`;
    await sql()`INSERT INTO tasks (id, conversation_id, description, type, due_at, created_by) VALUES (gen_random_uuid(), ${a}, 'later', 'followup', ${AT(HOUR)}, 'ai')`;
    await sql()`INSERT INTO tasks (id, conversation_id, description, type, created_by) VALUES (gen_random_uuid(), ${a}, 'untimed', 'followup', 'ai')`;
    // window closing but the owner already replied; and one on a resolved conversation
    await seedMessage(sql(), c, { direction: 'inbound', content: 'hello', occurredAt: AT(-23 * HOUR) });
    await seedMessage(sql(), c, { direction: 'outbound', content: 'hi!', occurredAt: AT(-22 * HOUR) });
    await sql()`UPDATE conversations SET last_inbound_at = ${AT(-23 * HOUR)}, window_expires_at = ${AT(HOUR)} WHERE id = ${c}`;
    await sql()`UPDATE conversations SET last_inbound_at = ${AT(-23 * HOUR)}, window_expires_at = ${AT(HOUR)} WHERE id = ${b}`;
    await seedMessage(sql(), a, { direction: 'outbound', status: 'failed', content: 'old', occurredAt: AT(-20 * DAY) });
    await seedMessage(sql(), a, { direction: 'outbound', status: 'sent', content: 'fine', occurredAt: AT(-HOUR) });
    expect(await getNeedsAttention(getDb(), NOW)).toEqual([]);
  });

  it('message problems are ONE row per customer, worded for what happened; a failed send stops counting once a later reply went through, an unknown one does not', async () => {
    const a = await conversation('Amina');
    const b = await conversation('Brian');
    const c = await conversation('Chloe');
    const d = await conversation('Dan');
    // Amina: three failures in a row -> one row, "3 replies"
    for (let i = 0; i < 3; i += 1) await seedMessage(sql(), a, { direction: 'outbound', status: 'failed', content: 'x', occurredAt: AT(-(5 - i) * HOUR) });
    // Brian: one failure, then the owner sent it again and it went through -> nothing to look at
    await seedMessage(sql(), b, { direction: 'outbound', status: 'failed', content: 'x', occurredAt: AT(-4 * HOUR) });
    await seedMessage(sql(), b, { direction: 'outbound', status: 'delivered', content: 'x again', occurredAt: AT(-3 * HOUR) });
    // Chloe: one unknown, and a later reply that went through: the unknown one still needs settling
    await seedMessage(sql(), c, { direction: 'outbound', status: 'unknown', content: 'x', occurredAt: AT(-4 * HOUR) });
    await seedMessage(sql(), c, { direction: 'outbound', status: 'sent', content: 'y', occurredAt: AT(-3 * HOUR) });
    // Dan: a failure, then a LATER one that is only queued: the owner has tried again, give it a chance
    await seedMessage(sql(), d, { direction: 'outbound', status: 'failed', content: 'x', occurredAt: AT(-4 * HOUR) });
    await seedMessage(sql(), d, { direction: 'outbound', status: 'queued', content: 'y', occurredAt: AT(-3 * HOUR) });
    const items = await getNeedsAttention(getDb(), NOW);
    expect(items.map((i) => [i.name, i.detail])).toEqual([
      ['Amina', '3 replies could not be sent.'], // newest problem first
      ['Chloe', 'A reply may not have been sent: check your phone and confirm.'],
    ]);
  });

  it('shows at most eight of each kind, oldest first (the most overdue leads)', async () => {
    const a = await conversation('Amina');
    for (let i = 0; i < 12; i += 1) {
      await sql()`INSERT INTO tasks (id, conversation_id, description, type, due_at, created_by) VALUES (gen_random_uuid(), ${a}, ${`task ${i}`}, 'followup', ${AT(-(i + 1) * HOUR)}, 'ai')`;
    }
    const items = await getNeedsAttention(getDb(), NOW);
    expect(items).toHaveLength(8);
    expect(items[0]?.detail).toBe('Overdue: task 11');
  });

  it('counts the conversations waiting on the owner', async () => {
    await conversation('Amina', 'waiting_on_me');
    await conversation('Brian', 'open');
    await conversation('Chloe', 'waiting_on_customer');
    await conversation('Dan', 'resolved');
    expect(await countWaitingOnYou(getDb())).toBe(2);
  });
});

describe('medianResponseTime (7 days)', () => {
  async function exchange(conv: string, askedMinutesAgo: number, repliedAfterMin: number | null, over: { replyStatus?: string; replyProvenance?: string } = {}) {
    await seedMessage(sql(), conv, { direction: 'inbound', content: 'question', occurredAt: AT(-askedMinutesAgo * MIN) });
    if (repliedAfterMin !== null) {
      await seedMessage(sql(), conv, { direction: 'outbound', content: 'answer', status: over.replyStatus ?? 'sent', provenance: over.replyProvenance ?? 'owner_manual', occurredAt: AT((-askedMinutesAgo + repliedAfterMin) * MIN) });
    }
  }

  it('is the median of how long the first message of each turn waited for the owner’s first reply (hand-computed: 10 min, 30 min, 120 min -> 30 min)', async () => {
    await exchange(await conversation('A'), 600, 10);
    await exchange(await conversation('B'), 500, 30);
    await exchange(await conversation('C'), 400, 120);
    expect(await medianResponseTime(getDb(), NOW, 7)).toEqual({ medianSeconds: 1800, samples: 3 });
  });

  it('an even number of samples takes the middle between the two (10 and 30 min -> 20 min)', async () => {
    await exchange(await conversation('A'), 600, 10);
    await exchange(await conversation('B'), 500, 30);
    expect(await medianResponseTime(getDb(), NOW, 7)).toEqual({ medianSeconds: 1200, samples: 2 });
  });

  it('measures from the FIRST message of a burst, counts a reply typed on the phone, and each new turn separately', async () => {
    const conv = await conversation('A');
    await seedMessage(sql(), conv, { direction: 'inbound', content: 'one', occurredAt: AT(-300 * MIN) });
    await seedMessage(sql(), conv, { direction: 'inbound', content: 'two', occurredAt: AT(-295 * MIN) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'reply', provenance: 'owner_app_echo', occurredAt: AT(-280 * MIN) }); // 20 min after "one"
    await seedMessage(sql(), conv, { direction: 'inbound', content: 'three', occurredAt: AT(-200 * MIN) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'reply 2', occurredAt: AT(-160 * MIN) }); // 40 min after "three"
    expect(await medianResponseTime(getDb(), NOW, 7)).toEqual({ medianSeconds: 1800, samples: 2 });
  });

  it('does not count: unanswered messages, failed replies, imported history, reactions, deleted messages, or anything older than the window', async () => {
    await exchange(await conversation('unanswered'), 300, null);
    await exchange(await conversation('failed reply'), 300, 5, { replyStatus: 'failed' });
    await exchange(await conversation('imported'), 300, 5, { replyProvenance: 'imported' });
    const reacted = await conversation('reaction');
    await seedMessage(sql(), reacted, { direction: 'inbound', type: 'reaction', content: '👍', occurredAt: AT(-300 * MIN) });
    await seedMessage(sql(), reacted, { direction: 'outbound', content: 'ok', occurredAt: AT(-290 * MIN) });
    const gone = await conversation('deleted');
    const g = await seedMessage(sql(), gone, { direction: 'inbound', content: 'x', occurredAt: AT(-300 * MIN) });
    await sql()`UPDATE messages SET deleted_at = now() WHERE id = ${g}`;
    await seedMessage(sql(), gone, { direction: 'outbound', content: 'ok', occurredAt: AT(-290 * MIN) });
    await exchange(await conversation('old'), 9 * 24 * 60, 5);
    expect(await medianResponseTime(getDb(), NOW, 7)).toEqual({ medianSeconds: null, samples: 0 });
  });

  it('imported history is invisible to the measure, even when it sits between live messages (an import run later)', async () => {
    const conv = await conversation('A');
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'live reply', occurredAt: AT(-400 * MIN) });
    await seedMessage(sql(), conv, { direction: 'inbound', content: 'imported question', provenance: 'imported', occurredAt: AT(-390 * MIN) });
    await seedMessage(sql(), conv, { direction: 'inbound', content: 'live question', occurredAt: AT(-380 * MIN) });
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'live answer', occurredAt: AT(-350 * MIN) }); // 30 min after the LIVE question
    expect(await medianResponseTime(getDb(), NOW, 7)).toEqual({ medianSeconds: 1800, samples: 1 });
  });

  it('a reply to an old message by another turn does not leak: only an outbound AFTER the question counts', async () => {
    const conv = await conversation('A');
    await seedMessage(sql(), conv, { direction: 'outbound', content: 'earlier reply', occurredAt: AT(-500 * MIN) });
    await seedMessage(sql(), conv, { direction: 'inbound', content: 'new question', occurredAt: AT(-100 * MIN) });
    expect(await medianResponseTime(getDb(), NOW, 7)).toEqual({ medianSeconds: null, samples: 0 });
    expect(FIXTURE.amina.wa).toBeTruthy();
  });
});
