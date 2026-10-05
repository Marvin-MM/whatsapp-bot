import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db';
import { countTasks, listConversationTasks, listTasks, recentConversations } from '@/lib/tasks/queries';
import { createEnrolledOwner, headersWith } from '../helpers/auth';
import { FIXTURE } from '../helpers/fixtures';
import { HOUR, NOW, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

const { createTask, setTaskStatus, updateTask } = await import('@/actions/tasks');

const h = setupIngestHarness();
const sql = () => h.admin();
beforeEach(() => {
  requestHeaders.current = new Headers();
});
afterEach(() => vi.unstubAllGlobals());

async function signedIn(): Promise<void> {
  requestHeaders.current = headersWith((await createEnrolledOwner()).cookie);
}
async function conversation(name = 'Amina', phone: string = FIXTURE.amina.wa, bsuid: string = FIXTURE.amina.bsuid): Promise<string> {
  const contact = await seedContact(sql(), { phone: `+${phone}`, bsuid, name });
  return seedConversation(sql(), contact, { status: 'waiting_on_me' });
}
async function task(conv: string, o: { description?: string; type?: string; status?: string; dueAt?: Date | null; source?: string | null; createdBy?: string } = {}): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    INSERT INTO tasks (id, conversation_id, description, type, status, due_at, created_by, source_message_id)
    VALUES (gen_random_uuid(), ${conv}, ${o.description ?? 'Call Amina'}, ${o.type ?? 'followup'}, ${o.status ?? 'open'}, ${o.dueAt ?? null}, ${o.createdBy ?? 'ai'}, ${o.source ?? null}) RETURNING id`;
  if (!row) throw new Error('task failed');
  return row.id;
}
const row = async (id: string) => (await sql()<{ status: string; description: string; due_at: Date | null; alerted_overdue_at: Date | null }[]>`SELECT status, description, due_at, alerted_overdue_at FROM tasks WHERE id = ${id}`)[0];
const audit = () => sql()<{ actor: string; action: string; entity_id: string; metadata: Record<string, unknown> }[]>`SELECT actor, action, entity_id, metadata FROM audit_log WHERE action LIKE 'task.%' ORDER BY created_at, id`;
const UUID = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

describe('createTask', () => {
  it('is owner-only', async () => {
    const conv = await conversation();
    expect(await createTask({ conversationId: conv, description: 'x', type: 'reminder' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
  });

  it('adds a task by the owner, reads the time as the OWNER’s wall clock, audits without the text, and tells the dashboard', async () => {
    await signedIn();
    const conv = await conversation();
    const due = new Date(Date.now() + 5 * HOUR);
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(due).replace(' ', 'T');
    const result = await createTask({ conversationId: conv, description: '  Deliver the SECRET parcel  ', type: 'followup', due: local });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const stored = await row(result.data.taskId);
    expect(stored?.description).toBe('Deliver the SECRET parcel');
    // minute precision, in the owner's zone
    expect(Math.abs((stored?.due_at?.getTime() ?? 0) - due.getTime())).toBeLessThan(60_000);
    const entries = await audit();
    expect(entries).toEqual([{ actor: 'owner', action: 'task.create', entity_id: result.data.taskId, metadata: expect.objectContaining({ via: 'owner', conversationId: conv, type: 'followup' }) }]);
    expect(JSON.stringify(entries)).not.toContain('SECRET');
    expect((await h.events()).filter((e) => e.type === 'task:changed')).toEqual([expect.objectContaining({ payload: { taskId: result.data.taskId, conversationId: conv } })]);
    const [created] = await sql()<{ created_by: string; source_message_id: string | null }[]>`SELECT created_by, source_message_id FROM tasks WHERE id = ${result.data.taskId}`;
    expect(created).toEqual({ created_by: 'owner', source_message_id: null });
  });

  it('a task needs no time, and an empty time box means "no time"', async () => {
    await signedIn();
    const conv = await conversation();
    expect(await createTask({ conversationId: conv, description: 'Think about it', type: 'reminder' })).toMatchObject({ ok: true });
    expect(await createTask({ conversationId: conv, description: 'Think again', type: 'reminder', due: '' })).toMatchObject({ ok: true });
    expect(await createTask({ conversationId: conv, description: 'And again', type: 'reminder', due: null })).toMatchObject({ ok: true });
  });

  it('refuses a time more than a day ago, with a reason, and writes nothing', async () => {
    await signedIn();
    const conv = await conversation();
    const result = await createTask({ conversationId: conv, description: 'Too late', type: 'reminder', due: '2020-01-01T10:00' });
    expect(result).toMatchObject({ ok: false, error: { code: 'refused', reason: 'bad_due' } });
    expect((await sql()`SELECT 1 FROM tasks`).length).toBe(0);
    expect((await audit()).length).toBe(0);
  });

  it('refuses a conversation that does not exist', async () => {
    await signedIn();
    expect(await createTask({ conversationId: UUID, description: 'x', type: 'reminder' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'conversation_not_found' } });
  });

  it.each([
    ['a non-uuid conversation', { conversationId: 'nope', description: 'x', type: 'reminder' }],
    ['an empty description', { conversationId: UUID, description: '   ', type: 'reminder' }],
    ['a 201-character description', { conversationId: UUID, description: 'x'.repeat(201), type: 'reminder' }],
    ['an unknown type', { conversationId: UUID, description: 'x', type: 'chore' }],
    ['a nonsense time', { conversationId: UUID, description: 'x', type: 'reminder', due: 'next tuesday' }],
    ['an impossible date', { conversationId: UUID, description: 'x', type: 'reminder', due: '2026-02-30T10:00' }],
  ])('validates input: %s', async (_name, input) => {
    await signedIn();
    expect(await createTask(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});

describe('setTaskStatus', () => {
  it('open -> done -> open -> cancelled, each audited, each told to the dashboard; reopening re-arms the overdue alert', async () => {
    await signedIn();
    const conv = await conversation();
    const id = await task(conv, { dueAt: new Date(NOW.getTime() - HOUR) });
    await sql()`UPDATE tasks SET alerted_overdue_at = now() WHERE id = ${id}`;

    expect(await setTaskStatus({ taskId: id, status: 'done' })).toMatchObject({ ok: true });
    expect((await row(id))?.status).toBe('done');
    expect(await setTaskStatus({ taskId: id, status: 'open' })).toMatchObject({ ok: true });
    expect(await row(id)).toMatchObject({ status: 'open', alerted_overdue_at: null });
    expect(await setTaskStatus({ taskId: id, status: 'cancelled' })).toMatchObject({ ok: true });
    expect((await row(id))?.status).toBe('cancelled');
    expect((await audit()).map((e) => e.action)).toEqual(['task.complete', 'task.reopen', 'task.cancel']);
    expect((await h.events()).filter((e) => e.type === 'task:changed')).toHaveLength(3);
  });

  it('refuses a task that is already in that state (a double click, a second tab, the analysis got there first) without writing', async () => {
    await signedIn();
    const conv = await conversation();
    const id = await task(conv, { status: 'done' });
    expect(await setTaskStatus({ taskId: id, status: 'done' })).toMatchObject({ ok: false, error: { code: 'refused', reason: 'wrong_status' } });
    expect(await setTaskStatus({ taskId: id, status: 'cancelled' })).toMatchObject({ ok: false, error: { reason: 'wrong_status' } });
    const open = await task(conv);
    expect(await setTaskStatus({ taskId: open, status: 'open' })).toMatchObject({ ok: false, error: { reason: 'wrong_status' } });
    expect((await audit()).length).toBe(0);
  });

  it('two racing completions: exactly one wins', async () => {
    await signedIn();
    const id = await task(await conversation());
    const results = await Promise.all([setTaskStatus({ taskId: id, status: 'done' }), setTaskStatus({ taskId: id, status: 'done' })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await audit()).filter((e) => e.action === 'task.complete')).toHaveLength(1);
  });

  it('unknown task, unauthorised, invalid input', async () => {
    expect(await setTaskStatus({ taskId: UUID, status: 'done' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    await signedIn();
    expect(await setTaskStatus({ taskId: UUID, status: 'done' })).toMatchObject({ ok: false, error: { reason: 'not_found' } });
    expect(await setTaskStatus({ taskId: UUID, status: 'deleted' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await setTaskStatus({ taskId: 'x', status: 'done' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});

describe('updateTask', () => {
  it('changes the wording and the time, re-arms the overdue alert, and audits WHAT changed (not the text)', async () => {
    await signedIn();
    const id = await task(await conversation(), { dueAt: new Date(NOW.getTime() - HOUR) });
    await sql()`UPDATE tasks SET alerted_overdue_at = now() WHERE id = ${id}`;
    const future = new Date(Date.now() + 30 * HOUR);
    const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Africa/Kampala', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(future).replace(' ', 'T');
    expect(await updateTask({ taskId: id, description: 'Call about the SECRET order', due: local })).toMatchObject({ ok: true });
    const stored = await row(id);
    expect(stored?.description).toBe('Call about the SECRET order');
    expect(stored?.alerted_overdue_at).toBeNull();
    expect(Math.abs((stored?.due_at?.getTime() ?? 0) - future.getTime())).toBeLessThan(60_000);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'task.update', metadata: { changed: ['description', 'dueAt'] } });
    expect(JSON.stringify(entry)).not.toContain('SECRET');
  });

  it('clears a time (null) and refuses an update that changes nothing, a closed task and a time in the distant past', async () => {
    await signedIn();
    const conv = await conversation();
    const id = await task(conv, { description: 'Same', dueAt: new Date(Date.now() + 5 * HOUR) });
    expect(await updateTask({ taskId: id, due: null })).toMatchObject({ ok: true });
    expect((await row(id))?.due_at).toBeNull();
    expect(await updateTask({ taskId: id, description: 'Same' })).toMatchObject({ ok: false, error: { reason: 'no_change' } });
    expect(await updateTask({ taskId: id, due: '2020-01-01T10:00' })).toMatchObject({ ok: false, error: { reason: 'bad_due' } });
    const done = await task(conv, { status: 'done' });
    expect(await updateTask({ taskId: done, description: 'Edit a closed task' })).toMatchObject({ ok: false, error: { reason: 'wrong_status' } });
    expect((await row(done))?.description).toBe('Call Amina');
  });

  it('is owner-only', async () => {
    const id = await task(await conversation());
    expect(await updateTask({ taskId: id, description: 'hijack' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect((await row(id))?.description).toBe('Call Amina');
  });
});

describe('the lists', () => {
  const DAY = 24 * HOUR;
  const TZ = 'Africa/Kampala';

  it('Open: late ones first (earliest first), then upcoming, then those with no time; Done and Cancelled newest first; every row names its customer', async () => {
    const a = await conversation('Amina');
    const b = await conversation('Brian', FIXTURE.brian.wa, FIXTURE.brian.bsuid);
    const none = await task(a, { description: 'no time' });
    const later = await task(b, { description: 'next week', dueAt: new Date(NOW.getTime() + 6 * DAY) });
    const lateOld = await task(a, { description: 'three days late', dueAt: new Date(NOW.getTime() - 3 * DAY) });
    const lateNew = await task(b, { description: 'an hour late', dueAt: new Date(NOW.getTime() - HOUR) });
    const soon = await task(a, { description: 'in an hour', dueAt: new Date(NOW.getTime() + HOUR) });
    const done1 = await task(a, { description: 'done first', status: 'done' });
    const done2 = await task(a, { description: 'done second', status: 'done' });
    await sql()`UPDATE tasks SET updated_at = now() - interval '1 hour' WHERE id = ${done1}`;
    await task(b, { description: 'dropped', status: 'cancelled' });

    const page = await listTasks(getDb(), { type: 'all', due: 'all' }, NOW, TZ);
    expect(page.open.map((t) => t.id)).toEqual([lateOld, lateNew, soon, later, none]);
    expect(page.done.map((t) => t.id)).toEqual([done2, done1]);
    expect(page.cancelled.map((t) => t.description)).toEqual(['dropped']);
    expect(page.open.find((t) => t.id === lateOld)).toMatchObject({ contactName: 'Amina', status: 'open', createdBy: 'ai', type: 'followup' });
    expect(page.open.find((t) => t.id === lateNew)?.contactName).toBe('Brian');
    expect(page.open[0]?.dueAt).toBeInstanceOf(Date);
  });

  it('filters by type and by due range in the OWNER’s calendar days', async () => {
    const conv = await conversation();
    // NOW is 2026-10-04 11:46 in Kampala. Today ends at 21:00Z; tomorrow starts then.
    const lateToday = await task(conv, { description: 'today 23:30', type: 'reminder', dueAt: new Date('2026-10-04T20:30:00Z') });
    const justTomorrow = await task(conv, { description: 'tomorrow 00:30', type: 'request', dueAt: new Date('2026-10-04T21:30:00Z') });
    const day7 = await task(conv, { description: 'in six days', type: 'followup', dueAt: new Date('2026-10-10T08:00:00Z') });
    // 2026-10-04 + 7 days = the eighth calendar day: outside "this week" (today and the six days after it).
    const day8 = await task(conv, { description: 'in seven days', type: 'followup', dueAt: new Date('2026-10-11T08:00:00Z') });
    const overdue = await task(conv, { description: 'late', type: 'followup', dueAt: new Date('2026-10-01T08:00:00Z') });
    const untimed = await task(conv, { description: 'untimed', type: 'request' });
    const ids = async (type: 'all' | 'request' | 'followup' | 'reminder', due: 'all' | 'overdue' | 'today' | 'week' | 'none') => (await listTasks(getDb(), { type, due }, NOW, TZ)).open.map((t) => t.id);

    expect(await ids('all', 'today')).toEqual([lateToday]);
    expect((await ids('all', 'week')).sort()).toEqual([lateToday, justTomorrow, day7].sort());
    expect(await ids('all', 'overdue')).toEqual([overdue]);
    expect(await ids('all', 'none')).toEqual([untimed]);
    expect((await ids('followup', 'all')).sort()).toEqual([day7, day8, overdue].sort());
    expect(await ids('request', 'none')).toEqual([untimed]);
    expect(await ids('reminder', 'overdue')).toEqual([]);
  });

  it('a task links to the message it came from, with a preview, and never shows what the customer took back', async () => {
    const conv = await conversation();
    const msg = await seedMessage(sql(), conv, { direction: 'inbound', content: 'Please call me tomorrow\nat three', occurredAt: NOW });
    const withSource = await task(conv, { description: 'with source', source: msg });
    const gone = await seedMessage(sql(), conv, { direction: 'inbound', content: 'DELETED-SECRET', occurredAt: NOW });
    await sql()`UPDATE messages SET deleted_at = now() WHERE id = ${gone}`;
    const withDeleted = await task(conv, { description: 'deleted source', source: gone });
    const manual = await task(conv, { description: 'manual', createdBy: 'owner' });
    const page = await listTasks(getDb(), { type: 'all', due: 'all' }, NOW, TZ);
    expect(page.open.find((t) => t.id === withSource)).toMatchObject({ sourceMessageId: msg, sourcePreview: 'Please call me tomorrow at three' });
    expect(page.open.find((t) => t.id === withDeleted)).toMatchObject({ sourceMessageId: gone, sourcePreview: null });
    expect(page.open.find((t) => t.id === manual)).toMatchObject({ sourceMessageId: null, sourcePreview: null, createdBy: 'owner' });
  });

  it('a conversation’s own list: its open tasks and the last five closed, nobody else’s', async () => {
    const mine = await conversation('Amina');
    const other = await conversation('Brian', FIXTURE.brian.wa, FIXTURE.brian.bsuid);
    const open = await task(mine, { description: 'mine open' });
    await task(other, { description: 'theirs' });
    for (let i = 0; i < 7; i += 1) await task(mine, { description: `closed ${i}`, status: i % 2 ? 'done' : 'cancelled' });
    const result = await listConversationTasks(getDb(), mine);
    expect(result.open.map((t) => t.id)).toEqual([open]);
    expect(result.recentlyClosed).toHaveLength(5);
    expect([...result.open, ...result.recentlyClosed].every((t) => t.conversationId === mine)).toBe(true);
  });

  it('counts open and overdue tasks', async () => {
    const conv = await conversation();
    await task(conv, { dueAt: new Date(NOW.getTime() - HOUR) });
    await task(conv, { dueAt: new Date(NOW.getTime() - 5 * HOUR) });
    await task(conv, { dueAt: new Date(NOW.getTime() + HOUR) });
    await task(conv);
    await task(conv, { status: 'done', dueAt: new Date(NOW.getTime() - HOUR) });
    expect(await countTasks(getDb(), NOW)).toEqual({ open: 4, overdue: 2 });
  });

  it('offers the most recently active conversations for "add a task"', async () => {
    const a = await conversation('Amina');
    const b = await conversation('Brian', FIXTURE.brian.wa, FIXTURE.brian.bsuid);
    await sql()`UPDATE conversations SET last_message_at = ${new Date(NOW.getTime() - DAY)} WHERE id = ${a}`;
    await sql()`UPDATE conversations SET last_message_at = ${NOW} WHERE id = ${b}`;
    expect((await recentConversations(getDb())).map((c) => c.name)).toEqual(['Brian', 'Amina']);
  });
});
