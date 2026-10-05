import type { AnalysisOperation } from '@/lib/ai/schemas';

/**
 * The model PROPOSES task changes; this decides which of them are acceptable (spec 9.5). Pure: the caller loads the conversation's open
 * tasks inside the same transaction that applies the plan, so what is checked here is what is true when it is written.
 */

/** A due date more than this far in the past is a model mistake (a wrong year, "yesterday" for "tomorrow"), not a task. */
export const MAX_PAST_DUE_MS = 24 * 60 * 60 * 1000;

export type TaskKind = 'request' | 'followup' | 'reminder';

export interface OpenTask {
  id: string;
  type: TaskKind;
  description: string;
  dueAt: Date | null;
}

export type RejectReason =
  | 'unknown_task' // an id that is not an OPEN task of THIS conversation (invented, another conversation's, already closed)
  | 'past_due'
  | 'invalid_date'
  | 'duplicate' // the same thing is already an open task (or repeated in this very answer)
  | 'closed_in_batch'
  | 'no_change';

export type PlannedOperation =
  | { op: 'create'; description: string; type: TaskKind; dueAt: Date | null }
  | { op: 'complete'; taskId: string }
  | { op: 'update'; taskId: string; description?: string; dueAt?: Date | null };

export interface Rejected {
  operation: AnalysisOperation;
  reason: RejectReason;
}

/** "Send the photos." and "send  the photos" are the same task. */
export function normaliseDescription(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDue(value: string | null | undefined, now: Date): { ok: true; due: Date | null } | { ok: false; reason: 'invalid_date' | 'past_due' } {
  if (value === null || value === undefined) return { ok: true, due: null };
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return { ok: false, reason: 'invalid_date' };
  if (due.getTime() < now.getTime() - MAX_PAST_DUE_MS) return { ok: false, reason: 'past_due' };
  return { ok: true, due };
}

export function planOperations(operations: readonly AnalysisOperation[], open: readonly OpenTask[], now: Date): { accepted: PlannedOperation[]; rejected: Rejected[] } {
  const byId = new Map(open.map((task) => [task.id, task]));
  const closed = new Set<string>();
  const touched = new Set<string>();
  // Descriptions already taken: the open tasks plus whatever this answer has created so far.
  const taken = new Set(open.map((task) => `${task.type}|${normaliseDescription(task.description)}`));
  const accepted: PlannedOperation[] = [];
  const rejected: Rejected[] = [];
  const reject = (operation: AnalysisOperation, reason: RejectReason) => rejected.push({ operation, reason });

  for (const operation of operations) {
    if (operation.op === 'create') {
      const description = operation.description.trim();
      const key = `${operation.type}|${normaliseDescription(description)}`;
      if (description === '' || normaliseDescription(description) === '') {
        reject(operation, 'no_change');
        continue;
      }
      const due = parseDue(operation.dueAt, now);
      if (!due.ok) {
        reject(operation, due.reason);
        continue;
      }
      if (taken.has(key)) {
        reject(operation, 'duplicate');
        continue;
      }
      taken.add(key);
      accepted.push({ op: 'create', description, type: operation.type, dueAt: due.due });
      continue;
    }

    const task = byId.get(operation.taskId);
    if (!task) {
      reject(operation, 'unknown_task');
      continue;
    }
    if (closed.has(task.id)) {
      reject(operation, 'closed_in_batch');
      continue;
    }

    if (operation.op === 'complete') {
      if (touched.has(`complete|${task.id}`)) {
        reject(operation, 'duplicate');
        continue;
      }
      touched.add(`complete|${task.id}`);
      closed.add(task.id);
      accepted.push({ op: 'complete', taskId: task.id });
      continue;
    }

    // update
    const description = operation.description?.trim();
    const changesDescription = description !== undefined && description !== '' && normaliseDescription(description) !== normaliseDescription(task.description);
    let changesDue = false;
    let due: Date | null | undefined;
    if (operation.dueAt !== undefined) {
      const parsed = parseDue(operation.dueAt, now);
      if (!parsed.ok) {
        reject(operation, parsed.reason);
        continue;
      }
      due = parsed.due;
      changesDue = (due?.getTime() ?? null) !== (task.dueAt?.getTime() ?? null);
    }
    if (!changesDescription && !changesDue) {
      reject(operation, 'no_change');
      continue;
    }
    accepted.push({
      op: 'update',
      taskId: task.id,
      ...(changesDescription && description !== undefined ? { description } : {}),
      ...(changesDue ? { dueAt: due ?? null } : {}),
    });
  }
  return { accepted, rejected };
}
