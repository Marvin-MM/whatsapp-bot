import 'server-only';
import { sql } from 'drizzle-orm';
import { displayName } from '@/lib/conversations/display';
import { oneLine, toDate } from '@/lib/conversations/queries';
import { EXPIRING_SOON_MS } from '@/lib/conversations/window';
import type { Db } from '@/lib/db';

/** Spec 12 "Needs attention": the things that go wrong quietly if nobody looks. Worst first. */
export type AttentionKind = 'message_problem' | 'task_overdue' | 'window_expiring' | 'draft_waiting';

export interface AttentionItem {
  kind: AttentionKind;
  /** Stable key for the list. */
  id: string;
  name: string;
  /** One line in plain words; may include a task's wording (the dashboard is the owner's own screen). */
  detail: string;
  /** When it started needing attention, for ordering and "for 40 min". */
  since: Date;
  href: string;
}

export const DRAFT_WAITING_MS = 30 * 60 * 1000;
const PER_KIND = 8;

interface NameRow extends Record<string, unknown> {
  display_name: string | null;
  username: string | null;
  phone_e164: string | null;
  bsuid: string | null;
}
const nameOf = (row: NameRow) => displayName({ displayName: row.display_name, username: row.username, phoneE164: row.phone_e164, bsuid: row.bsuid });

function problemDetail(unknown: number, failed: number): string {
  const replies = (n: number) => `${n} repl${n === 1 ? 'y' : 'ies'}`;
  if (unknown > 0 && failed > 0) return `${replies(unknown + failed)} need a look: some could not be sent, some may not have been sent.`;
  if (unknown > 0) return unknown === 1 ? 'A reply may not have been sent: check your phone and confirm.' : `${replies(unknown)} may not have been sent: check your phone and confirm.`;
  return failed === 1 ? 'A reply could not be sent.' : `${replies(failed)} could not be sent.`;
}

export async function getNeedsAttention(db: Db, now: Date): Promise<AttentionItem[]> {
  const iso = now.toISOString();

  // One row per customer, not per message: eight failed sends to the same person are one thing to look at. A failed message stops counting
  // once a LATER reply to that customer was accepted (the owner sent it again); an unknown one stays until the owner settles it.
  const problems = await db.execute<NameRow & { conversation_id: string; unknown_count: number; failed_count: number; newest: string | Date }>(sql`
    SELECT m.conversation_id,
           (count(*) FILTER (WHERE m.status = 'unknown'))::int AS unknown_count,
           (count(*) FILTER (WHERE m.status = 'failed'))::int AS failed_count,
           max(m.occurred_at) AS newest,
           ct.display_name, ct.username, ct.phone_e164, ct.bsuid
    FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
    WHERE m.direction = 'outbound' AND m.occurred_at > ${iso}::timestamptz - interval '14 days'
      AND (
        m.status = 'unknown'
        OR (m.status = 'failed' AND NOT EXISTS (
          SELECT 1 FROM messages o
          WHERE o.conversation_id = m.conversation_id AND o.direction = 'outbound' AND o.status IN ('queued', 'sent', 'delivered', 'read') AND o.occurred_at > m.occurred_at
        ))
      )
    GROUP BY m.conversation_id, ct.display_name, ct.username, ct.phone_e164, ct.bsuid
    ORDER BY newest DESC LIMIT ${PER_KIND}`);

  const overdue = await db.execute<NameRow & { id: string; description: string; due_at: string | Date; conversation_id: string }>(sql`
    SELECT t.id, t.description, t.due_at, t.conversation_id, ct.display_name, ct.username, ct.phone_e164, ct.bsuid
    FROM tasks t JOIN conversations c ON c.id = t.conversation_id JOIN contacts ct ON ct.id = c.contact_id
    WHERE t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at < ${iso}::timestamptz
    ORDER BY t.due_at LIMIT ${PER_KIND}`);

  const horizon = new Date(now.getTime() + EXPIRING_SOON_MS).toISOString();
  const windows = await db.execute<NameRow & { id: string; window_expires_at: string | Date }>(sql`
    SELECT c.id, c.window_expires_at, ct.display_name, ct.username, ct.phone_e164, ct.bsuid
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.window_expires_at > ${iso}::timestamptz AND c.window_expires_at <= ${horizon}::timestamptz AND c.status <> 'resolved'
      AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = c.id AND o.direction = 'outbound' AND o.status <> 'failed' AND o.occurred_at >= c.last_inbound_at)
    ORDER BY c.window_expires_at LIMIT ${PER_KIND}`);

  const drafts = await db.execute<NameRow & { id: string; created_at: string | Date }>(sql`
    SELECT d.id, d.created_at, ct.display_name, ct.username, ct.phone_e164, ct.bsuid
    FROM drafts d JOIN conversations c ON c.id = d.conversation_id JOIN contacts ct ON ct.id = c.contact_id
    WHERE d.status IN ('pending', 'scheduled') AND NOT d.no_reply_needed AND d.created_at < ${new Date(now.getTime() - DRAFT_WAITING_MS).toISOString()}::timestamptz
    ORDER BY d.created_at LIMIT ${PER_KIND}`);

  const minutes = (since: Date) => Math.max(1, Math.round((now.getTime() - since.getTime()) / 60_000));
  return [
    ...problems.map(
      (row): AttentionItem => ({
        kind: 'message_problem',
        id: `message:${row.conversation_id}`,
        name: nameOf(row),
        detail: problemDetail(row.unknown_count, row.failed_count),
        since: toDate(row.newest),
        href: `/conversations/${row.conversation_id}`,
      }),
    ),
    ...overdue.map((row): AttentionItem => ({
      kind: 'task_overdue',
      id: `task:${row.id}`,
      name: nameOf(row),
      detail: `Overdue: ${oneLine(row.description, 80)}`,
      since: toDate(row.due_at),
      href: `/tasks#task-${row.id}`,
    })),
    ...windows.map((row): AttentionItem => {
      const closes = toDate(row.window_expires_at);
      return {
        kind: 'window_expiring',
        id: `window:${row.id}`,
        name: nameOf(row),
        detail: `Reply window closes in ${Math.max(1, Math.round((closes.getTime() - now.getTime()) / 60_000))} min: after that only a template can be sent.`,
        since: closes,
        href: `/conversations/${row.id}`,
      };
    }),
    ...drafts.map((row): AttentionItem => {
      const created = toDate(row.created_at);
      return { kind: 'draft_waiting', id: `draft:${row.id}`, name: nameOf(row), detail: `A draft has been waiting ${minutes(created)} min for your decision.`, since: created, href: `/approvals?d=${row.id}` };
    }),
  ];
}

/** Conversations where the customer is waiting for the owner. */
export async function countWaitingOnYou(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM conversations WHERE status IN ('open', 'waiting_on_me')`);
  return rows[0]?.n ?? 0;
}
