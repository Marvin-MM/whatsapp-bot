'use server';

import { z } from 'zod';
import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { getEnv } from '@/lib/env';
import { publishEvent } from '@/lib/realtime/publish';
import { TaskRefused, createManualTask, setTaskStatus as changeStatus, updateOpenTask } from '@/lib/tasks/manage';
import { parseLocalDateTime } from '@/lib/tasks/present';
import { ownerAction } from './owner-action';

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TaskRefused) throw new ActionRefusal(error.code, error.message);
    throw error;
  }
}

/** Best effort: the change is committed; a lost dashboard event only means the page refreshes a moment later. */
const tell = (taskId: string, conversationId: string) => publishEvent({ type: 'task:changed', payload: { taskId, conversationId } }).catch(() => undefined);

const description = z.string().trim().min(1, 'Say what needs doing.').max(200, 'At most 200 characters.');
/** The value of a datetime-local box: the owner's own wall clock, no zone. `null` / empty means "no time". */
const dueLocal = z
  .string()
  .max(16)
  .nullable()
  .transform((value, ctx) => {
    if (value === null || value === '') return null;
    const parsed = parseLocalDateTime(value, getEnv().OWNER_TIMEZONE);
    if (parsed === null) ctx.addIssue({ code: 'custom', message: 'Not a valid date and time.' });
    return parsed;
  });

const createAction = ownerAction({
  name: 'tasks.create',
  schema: z.object({ conversationId: z.uuid(), description, type: z.enum(['request', 'followup', 'reminder']), due: dueLocal.default(null) }),
  handler: async ({ input, tx }) => {
    const { id } = await refusing(() => createManualTask(tx, { conversationId: input.conversationId, description: input.description, type: input.type, dueAt: input.due }));
    return {
      data: { taskId: id },
      audit: { action: 'task.create', entityType: 'task', entityId: id, metadata: { via: 'owner', conversationId: input.conversationId, type: input.type, dueAt: input.due?.toISOString() ?? null } },
      afterCommit: () => tell(id, input.conversationId),
    };
  },
});

/** The owner adds a task by hand (to a conversation). The text is not copied into the audit log. */
export async function createTask(input: unknown): Promise<ActionResult<{ taskId: string }>> {
  return createAction(input);
}

const statusAction = ownerAction({
  name: 'tasks.setStatus',
  schema: z.object({ taskId: z.uuid(), status: z.enum(['open', 'done', 'cancelled']) }),
  handler: async ({ input, tx }) => {
    const result = await refusing(() => changeStatus(tx, input.taskId, input.status));
    const action = input.status === 'done' ? 'task.complete' : input.status === 'cancelled' ? 'task.cancel' : 'task.reopen';
    return {
      data: { taskId: result.id },
      audit: { action, entityType: 'task', entityId: result.id, metadata: { via: 'owner', conversationId: result.conversationId, from: result.from } },
      afterCommit: () => tell(result.id, result.conversationId),
    };
  },
});

/** Done, cancelled, or open again. A click on a task that already changed (another tab, the analysis) is refused with a reason. */
export async function setTaskStatus(input: unknown): Promise<ActionResult<{ taskId: string }>> {
  return statusAction(input);
}

const updateAction = ownerAction({
  name: 'tasks.update',
  schema: z.object({ taskId: z.uuid(), description: description.optional(), due: dueLocal.optional() }),
  handler: async ({ input, tx }) => {
    const result = await refusing(() => updateOpenTask(tx, { taskId: input.taskId, ...(input.description !== undefined ? { description: input.description } : {}), ...(input.due !== undefined ? { dueAt: input.due } : {}) }));
    return {
      data: { taskId: result.id },
      audit: { action: 'task.update', entityType: 'task', entityId: result.id, metadata: { via: 'owner', conversationId: result.conversationId, changed: result.changed } },
      afterCommit: () => tell(result.id, result.conversationId),
    };
  },
});

/** Change an open task's wording or time. Changing the time re-arms the overdue alert. */
export async function updateTask(input: unknown): Promise<ActionResult<{ taskId: string }>> {
  return updateAction(input);
}
