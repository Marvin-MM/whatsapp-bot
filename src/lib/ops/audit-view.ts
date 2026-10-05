import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '@/lib/conversations/cursor';
import { toDate } from '@/lib/conversations/queries';
import type { Db } from '@/lib/db';
import { wallTimeToUtc } from '@/lib/import/zoned-time';
import { addDays } from '@/lib/metrics/analytics';

/**
 * The audit-log viewer (spec 12): who changed what, newest first, filterable by action, entity, actor and date range, in keyset pages (an
 * offset would skip or repeat entries while new ones arrive). Dates are the OWNER's calendar days. The log holds ids, kinds and counts, never
 * message text (that is enforced where entries are written), so showing its metadata verbatim is safe.
 */

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_ACTORS = ['owner', 'system', 'autopilot'] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export interface AuditFilters {
  action: string | null;
  entity: string | null;
  actor: (typeof AUDIT_ACTORS)[number] | null;
  /** Inclusive, owner's calendar days (`YYYY-MM-DD`). */
  from: string | null;
  to: string | null;
}

type RawParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The filters come straight from the address bar: anything malformed is dropped, never an error and never passed to SQL as anything but a bound value. */
export function parseAuditParams(raw: RawParams): { filters: AuditFilters; cursor: string | null } {
  const text = z.string().trim().min(1).max(80);
  const pick = <T>(schema: z.ZodType<T>, value: string | undefined): T | null => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };
  const from = pick(day, first(raw.from));
  const to = pick(day, first(raw.to));
  const valid = (value: string | null) => (value !== null && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) && addDays(value, 0) === value ? value : null);
  return {
    filters: {
      action: pick(text, first(raw.action)),
      entity: pick(text, first(raw.entity)),
      actor: pick(z.enum(AUDIT_ACTORS), first(raw.actor)),
      from: valid(from),
      to: valid(to),
    },
    cursor: first(raw.cursor)?.slice(0, 400) ?? null,
  };
}

export interface AuditRow {
  id: string;
  at: Date;
  actor: (typeof AUDIT_ACTORS)[number];
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
}

interface Raw extends Record<string, unknown> {
  id: string;
  created_at: string | Date;
  cursor_t: string;
  actor: (typeof AUDIT_ACTORS)[number];
  action: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
}

const MICROS = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

export async function listAudit(db: Db, filters: AuditFilters, cursorParam: string | null, timeZone: string, limit = AUDIT_PAGE_SIZE): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
  const cursor = decodeCursor(cursorParam);
  const start = (value: string) => {
    const [year, month, date] = value.split('-').map(Number);
    return wallTimeToUtc({ year: year ?? 1970, month: month ?? 1, day: date ?? 1, hour: 0, minute: 0, second: 0 }, timeZone).toISOString();
  };
  const conditions = [
    filters.action ? sql`AND action = ${filters.action}` : sql``,
    filters.entity ? sql`AND entity_type = ${filters.entity}` : sql``,
    filters.actor ? sql`AND actor = ${filters.actor}::audit_actor` : sql``,
    filters.from ? sql`AND created_at >= ${start(filters.from)}::timestamptz` : sql``,
    // "to" is a whole day: everything before the NEXT day's local midnight.
    filters.to ? sql`AND created_at < ${start(addDays(filters.to, 1))}::timestamptz` : sql``,
    cursor?.t ? sql`AND (created_at, id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : sql``,
  ];
  const rows = await db.execute<Raw>(sql`
    SELECT id, created_at, to_char(created_at AT TIME ZONE 'UTC', ${MICROS}) AS cursor_t, actor, action, entity_type, entity_id, metadata
    FROM audit_log
    WHERE true ${sql.join(conditions, sql` `)}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}`);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((row) => ({ id: row.id, at: toDate(row.created_at), actor: row.actor, action: row.action, entityType: row.entity_type, entityId: row.entity_id, metadata: row.metadata })),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
  };
}

/** The values the filter boxes offer: what is actually in the log. */
export async function listAuditFilterOptions(db: Db): Promise<{ actions: string[]; entities: string[] }> {
  const actions = await db.execute<{ action: string }>(sql`SELECT DISTINCT action FROM audit_log ORDER BY action LIMIT 300`);
  const entities = await db.execute<{ entity_type: string }>(sql`SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type LIMIT 100`);
  return { actions: actions.map((row) => row.action), entities: entities.map((row) => row.entity_type) };
}
