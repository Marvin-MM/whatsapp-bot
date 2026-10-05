import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { conversations, tasks } from '@/lib/db/schema';
import { MAX_PAST_DUE_MS } from '@/lib/analysis/operations';
import type { TaskType } from './present';

/**
 * The owner's own task changes. Each runs inside the caller's transaction (an `ownerAction`) with its audit entry; the status changes are
 * conditional updates, so two clicks (or a click racing the analysis completing the same task) cannot both win.
 */

export class TaskRefused extends Error {
  constructor(
    readonly code: 'not_found' | 'wrong_status' | 'bad_due' | 'no_change' | 'conversation_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'TaskRefused';
  }
}

/** The same one-day tolerance as the analysis: a due time of "yesterday" is a typo, not a task. */
function checkDue(dueAt: Date | null, now: Date): void {
  if (dueAt !== null && dueAt.getTime() < now.getTime() - MAX_PAST_DUE_MS) throw new TaskRefused('bad_due', 'That time was more than a day ago. Pick a time from now on.');
}

export async function createManualTask(tx: Tx, input: { conversationId: string; description: string; type: TaskType; dueAt: Date | null; now?: Date }): Promise<{ id: string }> {
  checkDue(input.dueAt, input.now ?? new Date());
  const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, input.conversationId)).limit(1);
  if (!conversation) throw new TaskRefused('conversation_not_found', 'That conversation no longer exists.');
  const [row] = await tx
    .insert(tasks)
    .values({ conversationId: input.conversationId, description: input.description.trim(), type: input.type, dueAt: input.dueAt, createdBy: 'owner' })
    .returning({ id: tasks.id });
  if (!row) throw new Error('task insert returned nothing');
  return row;
}

const ALLOWED_FROM = { done: ['open'], cancelled: ['open'], open: ['done', 'cancelled'] } as const;

/** open -> done | cancelled, and done | cancelled -> open again. Reopening re-arms the overdue alert (the task may still be late). */
export async function setTaskStatus(tx: Tx, taskId: string, to: 'open' | 'done' | 'cancelled'): Promise<{ id: string; conversationId: string; from: string }> {
  const [before] = await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!before) throw new TaskRefused('not_found', 'That task no longer exists.');
  const [row] = await tx
    .update(tasks)
    .set({ status: to, ...(to === 'open' ? { alertedOverdueAt: null } : {}) })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, [...ALLOWED_FROM[to]])))
    .returning({ id: tasks.id, conversationId: tasks.conversationId });
  if (!row) throw new TaskRefused('wrong_status', to === 'open' ? 'That task is already open.' : `That task is already ${before.status === 'done' ? 'done' : 'cancelled'}.`);
  return { ...row, from: before.status };
}

export async function updateOpenTask(
  tx: Tx,
  input: { taskId: string; description?: string; dueAt?: Date | null; now?: Date },
): Promise<{ id: string; conversationId: string; changed: string[] }> {
  const [current] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update');
  if (!current) throw new TaskRefused('not_found', 'That task no longer exists.');
  if (current.status !== 'open') throw new TaskRefused('wrong_status', 'Reopen the task before changing it.');

  const changed: string[] = [];
  const patch: Partial<typeof tasks.$inferInsert> = {};
  const description = input.description?.trim();
  if (description !== undefined && description !== '' && description !== current.description) {
    patch.description = description;
    changed.push('description');
  }
  if (input.dueAt !== undefined && (input.dueAt?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null)) {
    checkDue(input.dueAt, input.now ?? new Date());
    patch.dueAt = input.dueAt;
    patch.alertedOverdueAt = null; // a new time is a new chance to be reminded
    changed.push('dueAt');
  }
  if (changed.length === 0) throw new TaskRefused('no_change', 'Nothing changed.');
  await tx.update(tasks).set(patch).where(eq(tasks.id, input.taskId));
  return { id: current.id, conversationId: current.conversationId, changed };
}
