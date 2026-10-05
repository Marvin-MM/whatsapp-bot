import 'server-only';
import { sql } from 'drizzle-orm';
import { displayName } from '@/lib/conversations/display';
import { oneLine, toDate } from '@/lib/conversations/queries';
import type { Db } from '@/lib/db';
import type { TaskType } from './present';

export type TaskStatus = 'open' | 'done' | 'cancelled';

export interface TaskItem {
  id: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  dueAt: Date | null;
  createdBy: 'ai' | 'owner';
  createdAt: Date;
  conversationId: string;
  contactName: string;
  /** The message the task came from (null for a task the owner typed in): the page links to it. */
  sourceMessageId: string | null;
  sourcePreview: string | null;
}

export const DUE_FILTERS = ['all', 'overdue', 'today', 'week', 'none'] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];
export const TYPE_FILTERS = ['all', 'request', 'followup', 'reminder'] as const;
export type TypeFilter = (typeof TYPE_FILTERS)[number];

export interface TaskFilters {
  type: TypeFilter;
  due: DueFilter;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  due_at: string | Date | null;
  created_by: 'ai' | 'owner';
  created_at: string | Date;
  conversation_id: string;
  display_name: string | null;
  username: string | null;
  phone_e164: string | null;
  bsuid: string | null;
  source_message_id: string | null;
  source_content: string | null;
  source_deleted: boolean | null;
}

const toItem = (row: TaskRow): TaskItem => ({
  id: row.id,
  description: row.description,
  type: row.type,
  status: row.status,
  dueAt: row.due_at === null ? null : toDate(row.due_at),
  createdBy: row.created_by,
  createdAt: toDate(row.created_at),
  conversationId: row.conversation_id,
  contactName: displayName({ displayName: row.display_name, username: row.username, phoneE164: row.phone_e164, bsuid: row.bsuid }),
  sourceMessageId: row.source_message_id,
  // What a customer took back is not shown again.
  sourcePreview: row.source_message_id !== null && row.source_deleted !== true && row.source_content ? oneLine(row.source_content, 90) : null,
});

const SELECT = sql`
  SELECT t.id, t.description, t.type, t.status, t.due_at, t.created_by, t.created_at, t.conversation_id,
         ct.display_name, ct.username, ct.phone_e164, ct.bsuid,
         t.source_message_id, m.content AS source_content, (m.deleted_at IS NOT NULL) AS source_deleted
  FROM tasks t
  JOIN conversations c ON c.id = t.conversation_id
  JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN messages m ON m.id = t.source_message_id`;

/** The owner's "today" and "this week" are THEIR calendar days, not UTC's: a task due at 23:30 Kampala time is due today. */
function dueClause(due: DueFilter, now: Date, timeZone: string) {
  const iso = now.toISOString();
  switch (due) {
    case 'overdue':
      return sql`AND t.due_at IS NOT NULL AND t.due_at < ${iso}::timestamptz`;
    case 'today':
      return sql`AND t.due_at IS NOT NULL AND (t.due_at AT TIME ZONE ${timeZone})::date = (${iso}::timestamptz AT TIME ZONE ${timeZone})::date`;
    case 'week':
      return sql`AND t.due_at IS NOT NULL AND (t.due_at AT TIME ZONE ${timeZone})::date BETWEEN (${iso}::timestamptz AT TIME ZONE ${timeZone})::date AND (${iso}::timestamptz AT TIME ZONE ${timeZone})::date + 6`;
    case 'none':
      return sql`AND t.due_at IS NULL`;
    default:
      return sql``;
  }
}

export const CLOSED_LIMIT = 50;
export const OPEN_LIMIT = 300;

export interface TaskPage {
  open: TaskItem[];
  done: TaskItem[];
  cancelled: TaskItem[];
}

/**
 * The tasks page: open tasks with the ones that are LATE first (a due date sorts before none, earliest first, so overdue ones lead),
 * then what was done and cancelled most recently. Filters apply to all three lists.
 */
export async function listTasks(db: Db, filters: TaskFilters, now: Date, timeZone: string): Promise<TaskPage> {
  const type = filters.type === 'all' ? sql`` : sql`AND t.type = ${filters.type}::task_type`;
  const due = dueClause(filters.due, now, timeZone);
  const open = await db.execute<TaskRow>(sql`${SELECT} WHERE t.status = 'open' ${type} ${due} ORDER BY (t.due_at IS NULL), t.due_at, t.created_at, t.id LIMIT ${OPEN_LIMIT}`);
  const closed = (status: 'done' | 'cancelled') =>
    db.execute<TaskRow>(sql`${SELECT} WHERE t.status = ${status}::task_status ${type} ${due} ORDER BY t.updated_at DESC, t.id LIMIT ${CLOSED_LIMIT}`);
  const [done, cancelled] = await Promise.all([closed('done'), closed('cancelled')]);
  return { open: open.map(toItem), done: done.map(toItem), cancelled: cancelled.map(toItem) };
}

/** One conversation's tasks for its sidebar: everything open, and the last few finished. */
export async function listConversationTasks(db: Db, conversationId: string): Promise<{ open: TaskItem[]; recentlyClosed: TaskItem[] }> {
  const open = await db.execute<TaskRow>(sql`${SELECT} WHERE t.conversation_id = ${conversationId}::uuid AND t.status = 'open' ORDER BY (t.due_at IS NULL), t.due_at, t.created_at, t.id`);
  const closed = await db.execute<TaskRow>(sql`${SELECT} WHERE t.conversation_id = ${conversationId}::uuid AND t.status <> 'open' ORDER BY t.updated_at DESC, t.id LIMIT 5`);
  return { open: open.map(toItem), recentlyClosed: closed.map(toItem) };
}

/** Open tasks, and how many of them are late: the Overview and the Tasks tab. */
export async function countTasks(db: Db, now: Date): Promise<{ open: number; overdue: number }> {
  const rows = await db.execute<{ open: number; overdue: number }>(sql`
    SELECT count(*)::int AS open, (count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < ${now.toISOString()}::timestamptz))::int AS overdue
    FROM tasks WHERE status = 'open'`);
  return { open: rows[0]?.open ?? 0, overdue: rows[0]?.overdue ?? 0 };
}

export interface ConversationChoice {
  id: string;
  name: string;
}

/** For "add a task": the conversations the owner most recently touched. */
export async function recentConversations(db: Db, limit = 40): Promise<ConversationChoice[]> {
  const rows = await db.execute<{ id: string; display_name: string | null; username: string | null; phone_e164: string | null; bsuid: string | null }>(sql`
    SELECT c.id, ct.display_name, ct.username, ct.phone_e164, ct.bsuid
    FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    ORDER BY c.last_message_at DESC NULLS LAST, c.id LIMIT ${limit}`);
  return rows.map((row) => ({ id: row.id, name: displayName({ displayName: row.display_name, username: row.username, phoneE164: row.phone_e164, bsuid: row.bsuid }) }));
}
