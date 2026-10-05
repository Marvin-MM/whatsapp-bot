import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { AUDIT_PAGE_SIZE, type AuditFilters, listAudit, listAuditFilterOptions, parseAuditParams } from '@/lib/ops/audit-view';
import { setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();
const TZ = 'Africa/Kampala';
const none: AuditFilters = { action: null, entity: null, actor: null, from: null, to: null };

async function entry(at: string, o: { actor?: string; action?: string; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {}): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    INSERT INTO audit_log (id, actor, action, entity_type, entity_id, metadata, created_at)
    VALUES (gen_random_uuid(), ${o.actor ?? 'owner'}::audit_actor, ${o.action ?? 'task.create'}, ${o.entityType ?? 'task'}, ${o.entityId ?? 'e1'}, ${sql().json((o.metadata ?? {}) as never)}, ${new Date(at)})
    RETURNING id`;
  if (!row) throw new Error('entry failed');
  return row.id;
}
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe('paging', () => {
  it('is newest first, in keyset pages that neither skip nor repeat an entry', async () => {
    const all: string[] = [];
    for (let i = 0; i < 7; i += 1) all.push(await entry(`2026-10-01T10:0${i}:00Z`));
    const expected = [...all].reverse();

    const first = await listAudit(getDb(), none, null, TZ, 3);
    expect(ids(first.rows)).toEqual(expected.slice(0, 3));
    expect(first.nextCursor).not.toBeNull();
    const second = await listAudit(getDb(), none, first.nextCursor, TZ, 3);
    expect(ids(second.rows)).toEqual(expected.slice(3, 6));
    const third = await listAudit(getDb(), none, second.nextCursor, TZ, 3);
    expect(ids(third.rows)).toEqual(expected.slice(6));
    expect(third.nextCursor).toBeNull();
  });

  it('entries with the SAME timestamp are ordered by id and still paged exactly once', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) created.push(await entry('2026-10-01T10:00:00Z'));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result = await listAudit(getDb(), none, cursor, TZ, 2);
      seen.push(...ids(result.rows));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...created].sort());
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it('a new entry arriving between pages does not shift the next page (that is why it is keyset, not offset)', async () => {
    for (let i = 0; i < 6; i += 1) await entry(`2026-10-01T10:0${i}:00Z`);
    const first = await listAudit(getDb(), none, null, TZ, 3);
    await entry('2026-10-02T10:00:00Z'); // newer than everything
    const second = await listAudit(getDb(), none, first.nextCursor, TZ, 3);
    expect([...ids(first.rows), ...ids(second.rows)]).toHaveLength(6);
    expect(new Set([...ids(first.rows), ...ids(second.rows)]).size).toBe(6);
  });

  it('a malformed cursor is the first page, not an error', async () => {
    await entry('2026-10-01T10:00:00Z');
    expect((await listAudit(getDb(), none, 'not-a-cursor', TZ)).rows).toHaveLength(1);
  });

  it('shows 50 per page by default', async () => {
    for (let i = 0; i < AUDIT_PAGE_SIZE + 1; i += 1) await entry(`2026-10-01T10:00:${String(i).padStart(2, '0')}Z`);
    const page = await listAudit(getDb(), none, null, TZ);
    expect(page.rows).toHaveLength(AUDIT_PAGE_SIZE);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('filters', () => {
  it('by action, entity type and actor, alone and together', async () => {
    const a = await entry('2026-10-01T10:00:00Z', { action: 'task.create', entityType: 'task', actor: 'owner' });
    const b = await entry('2026-10-01T10:01:00Z', { action: 'task.create', entityType: 'task', actor: 'system' });
    const c = await entry('2026-10-01T10:02:00Z', { action: 'draft.approve', entityType: 'draft', actor: 'owner' });
    const run = async (filters: Partial<AuditFilters>) => ids((await listAudit(getDb(), { ...none, ...filters }, null, TZ)).rows);
    expect((await run({ action: 'task.create' })).sort()).toEqual([a, b].sort());
    expect(await run({ entity: 'draft' })).toEqual([c]);
    expect(await run({ actor: 'system' })).toEqual([b]);
    expect(await run({ action: 'task.create', actor: 'owner' })).toEqual([a]);
    expect(await run({ action: 'task.create', entity: 'draft' })).toEqual([]);
  });

  it('by date range in the OWNER’s calendar days: 00:30 local is the next day even though UTC says the previous one; "to" includes the whole day', async () => {
    const lateEvening = await entry('2026-09-29T20:30:00Z'); // 23:30 on the 29th in Kampala
    const justAfterMidnight = await entry('2026-09-29T21:30:00Z'); // 00:30 on the 30th in Kampala (UTC: still the 29th)
    const endOfThirtieth = await entry('2026-09-30T20:59:00Z'); // 23:59 on the 30th
    const firstOfOctober = await entry('2026-09-30T21:00:00Z'); // 00:00 on 1 Oct
    const range = async (from: string | null, to: string | null) => ids((await listAudit(getDb(), { ...none, from, to }, null, TZ)).rows).sort();

    expect(await range('2026-09-30', '2026-09-30')).toEqual([justAfterMidnight, endOfThirtieth].sort());
    expect(await range(null, '2026-09-29')).toEqual([lateEvening]);
    expect(await range('2026-10-01', null)).toEqual([firstOfOctober]);
    expect(await range('2026-09-29', '2026-10-01')).toHaveLength(4);
    expect(await range('2026-10-02', null)).toEqual([]);
  });

  it('a hostile filter value is just a value that matches nothing', async () => {
    await entry('2026-10-01T10:00:00Z');
    const { filters } = parseAuditParams({ action: "'; DROP TABLE audit_log; --" });
    expect((await listAudit(getDb(), filters, null, TZ)).rows).toEqual([]);
    expect((await listAudit(getDb(), none, null, TZ)).rows).toHaveLength(1);
  });
});

describe('what a row carries', () => {
  it('returns the actor, action, entity and metadata exactly, with the time as a Date', async () => {
    await entry('2026-10-01T10:00:00.123456Z', { actor: 'system', action: 'task.update', entityType: 'task', entityId: 'T-1', metadata: { via: 'analysis', changed: ['dueAt'], n: 3 } });
    const [row] = (await listAudit(getDb(), none, null, TZ)).rows;
    expect(row).toMatchObject({ actor: 'system', action: 'task.update', entityType: 'task', entityId: 'T-1', metadata: { via: 'analysis', changed: ['dueAt'], n: 3 } });
    expect(row?.at.toISOString()).toBe('2026-10-01T10:00:00.123Z');
  });

  it('offers the actions and entity types that are actually in the log, once each, sorted', async () => {
    await entry('2026-10-01T10:00:00Z', { action: 'b.act', entityType: 'zeta' });
    await entry('2026-10-01T10:01:00Z', { action: 'a.act', entityType: 'alpha' });
    await entry('2026-10-01T10:02:00Z', { action: 'a.act', entityType: 'alpha' });
    expect(await listAuditFilterOptions(getDb())).toEqual({ actions: ['a.act', 'b.act'], entities: ['alpha', 'zeta'] });
  });
});
