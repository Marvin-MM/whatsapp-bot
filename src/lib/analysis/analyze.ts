import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import { raiseAlert } from '@/lib/alerts';
import { reasoningFor } from '@/lib/ai/draft';
import { AiProviderError } from '@/lib/ai/errors';
import { chatModelId } from '@/lib/ai/models';
import { ANALYSIS_PROMPT_VERSION, type AnalysisContext, type AnalysisLine, MAX_ANALYSIS_MESSAGES, analysisInstructions, analysisUserPrompt } from '@/lib/ai/prompts/analysis';
import { runStructured } from '@/lib/ai/run';
import { type AnalysisOutput, analysisOutputSchema } from '@/lib/ai/schemas';
import { UNRELIABLE_LABEL } from '@/lib/ai/transcribe';
import { writeAudit } from '@/lib/audit';
import { toDate } from '@/lib/conversations/queries';
import { type Db, type Tx, getDb } from '@/lib/db';
import { conversations, settings, tasks } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { type Effect, runEffects } from '@/lib/ingest/effects';
import { logger } from '@/lib/logger';
import { type OpenTask, type PlannedOperation, type RejectReason, planOperations } from './operations';

/**
 * Post-send analysis (spec 9.5): after the owner's reply, keep a rolling summary of the conversation and the list of things the owner owes.
 *
 * The model call never holds a transaction. What is applied is decided against the state INSIDE the transaction that applies it (the
 * conversation row is locked, the open tasks are read again), so a task the owner completed while the model was thinking cannot be
 * completed twice or edited after the fact. A run that finds the summary already covers its messages does nothing: running twice on the
 * same conversation creates nothing twice.
 */

export type AnalysisOutcome = 'applied' | 'skipped_ai_paused' | 'nothing_new' | 'already_covered' | 'no_message';

export interface AnalysisResult {
  outcome: AnalysisOutcome;
  created?: number;
  completed?: number;
  updated?: number;
  rejected?: Partial<Record<RejectReason, number>>;
}

export interface AnalyzeOptions {
  /** The queue's last attempt: a failure is given up on visibly (an alert) instead of silently retried. */
  finalAttempt: boolean;
  now?: Date;
  db?: Db;
}

/** The summary moved on while the model was thinking, but not far enough to include this run's messages: run again with fresh state. */
export class AnalysisStaleError extends Error {
  constructor() {
    super('The conversation changed while it was being analysed.');
    this.name = 'AnalysisStaleError';
  }
}

interface WindowRow extends Record<string, unknown> {
  id: string;
  direction: 'inbound' | 'outbound';
  content: string | null;
  transcription_status: 'pending' | 'done' | 'failed' | 'low_confidence' | null;
  deleted_at: string | Date | null;
  occurred_at: string | Date;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The newest messages after the last one the summary covers, newest first in SQL, oldest first here. Reactions never matter. An outbound
 * message counts only once Meta has it (`sent` or later): a queued, unknown or failed one is not something the customer was told.
 */
async function loadWindow(db: Db | Tx, conversationId: string, throughId: string | null): Promise<WindowRow[]> {
  const rows = await db.execute<WindowRow>(sql`
    SELECT m.id, m.direction, m.content, m.transcription_status, m.deleted_at, m.occurred_at
    FROM messages m
    WHERE m.conversation_id = ${conversationId}::uuid
      AND m.type <> 'reaction'
      AND (m.direction = 'inbound' OR m.status IN ('sent', 'delivered', 'read'))
      AND (
        ${throughId}::uuid IS NULL
        OR (m.occurred_at, m.id) > (
          coalesce((SELECT t.occurred_at FROM messages t WHERE t.id = ${throughId}::uuid), '-infinity'::timestamptz),
          coalesce((SELECT t.id FROM messages t WHERE t.id = ${throughId}::uuid), ${ZERO_UUID}::uuid)
        )
      )
    ORDER BY m.occurred_at DESC, m.id DESC
    LIMIT ${MAX_ANALYSIS_MESSAGES}
  `);
  return [...rows].reverse();
}

/** What the model may read of a message: nothing the customer took back, nothing unreadable, nothing empty. */
function lineOf(row: WindowRow): AnalysisLine | null {
  if (row.deleted_at !== null) return null;
  if (row.transcription_status === 'low_confidence' || row.transcription_status === 'failed' || row.transcription_status === 'pending') return null;
  const text = row.content?.trim();
  if (!text || text === UNRELIABLE_LABEL) return null;
  return { at: toDate(row.occurred_at), from: row.direction === 'inbound' ? 'customer' : 'owner', text };
}

async function openTasksOf(db: Db | Tx, conversationId: string): Promise<(OpenTask & { id: string })[]> {
  const rows = await db
    .select({ id: tasks.id, type: tasks.type, description: tasks.description, dueAt: tasks.dueAt })
    .from(tasks)
    .where(and(eq(tasks.conversationId, conversationId), eq(tasks.status, 'open')))
    .orderBy(asc(tasks.createdAt), asc(tasks.id))
    .limit(40);
  return rows;
}

interface Applied {
  created: string[];
  completed: string[];
  updated: string[];
  rejected: Partial<Record<RejectReason, number>>;
  effects: Effect[];
}

/** Applies a plan inside the transaction, one audit entry per change (never the task text: it is derived from what a customer wrote). */
async function applyPlan(
  tx: Tx,
  conversationId: string,
  plan: readonly PlannedOperation[],
  sources: { customer: string | null; owner: string | null },
  summaryMessageId: string,
): Promise<Pick<Applied, 'created' | 'completed' | 'updated'>> {
  const created: string[] = [];
  const completed: string[] = [];
  const updated: string[] = [];
  for (const operation of plan) {
    if (operation.op === 'create') {
      // A request is something the CUSTOMER said; a follow-up or reminder is something the owner promised.
      const source = operation.type === 'request' ? (sources.customer ?? sources.owner) : (sources.owner ?? sources.customer);
      const [row] = await tx
        .insert(tasks)
        .values({ conversationId, sourceMessageId: source, description: operation.description, type: operation.type, dueAt: operation.dueAt, createdBy: 'ai' })
        .returning({ id: tasks.id });
      if (!row) throw new Error('task insert returned nothing');
      created.push(row.id);
      await writeAudit(tx, {
        actor: 'system',
        action: 'task.create',
        entityType: 'task',
        entityId: row.id,
        metadata: { via: 'analysis', conversationId, type: operation.type, dueAt: operation.dueAt?.toISOString() ?? null, throughMessageId: summaryMessageId },
      });
    } else if (operation.op === 'complete') {
      const [row] = await tx
        .update(tasks)
        .set({ status: 'done' })
        .where(and(eq(tasks.id, operation.taskId), eq(tasks.conversationId, conversationId), eq(tasks.status, 'open')))
        .returning({ id: tasks.id });
      if (!row) continue;
      completed.push(row.id);
      await writeAudit(tx, { actor: 'system', action: 'task.complete', entityType: 'task', entityId: row.id, metadata: { via: 'analysis', conversationId, throughMessageId: summaryMessageId } });
    } else {
      const [row] = await tx
        .update(tasks)
        .set({
          ...(operation.description !== undefined ? { description: operation.description } : {}),
          // A new due time is a new chance to be reminded: the overdue alert fires again for it.
          ...(operation.dueAt !== undefined ? { dueAt: operation.dueAt, alertedOverdueAt: null } : {}),
        })
        .where(and(eq(tasks.id, operation.taskId), eq(tasks.conversationId, conversationId), eq(tasks.status, 'open')))
        .returning({ id: tasks.id });
      if (!row) continue;
      updated.push(row.id);
      await writeAudit(tx, {
        actor: 'system',
        action: 'task.update',
        entityType: 'task',
        entityId: row.id,
        metadata: {
          via: 'analysis',
          conversationId,
          changed: [...(operation.description !== undefined ? ['description'] : []), ...(operation.dueAt !== undefined ? ['dueAt'] : [])],
          dueAt: operation.dueAt === undefined ? undefined : (operation.dueAt?.toISOString() ?? null),
          throughMessageId: summaryMessageId,
        },
      });
    }
  }
  return { created, completed, updated };
}

async function alertFailure(error: Error, conversationId: string, now: Date): Promise<void> {
  if (error instanceof AiProviderError && (error.status === 401 || error.status === 403)) {
    await raiseAlert({ kind: 'ai_key_invalid', severity: 'critical', dedupeKey: `ai_key_invalid:${now.toISOString().slice(0, 10)}` });
  } else {
    await raiseAlert({ kind: 'analysis_failed', severity: 'warning', entityId: conversationId, dedupeKey: `analysis_failed:${conversationId}:${now.toISOString().slice(0, 10)}` });
  }
}

/** Runs the analysis for the conversation that `messageId` (an accepted outbound message) belongs to. */
export async function analyzeAfterMessage(messageId: string, options: AnalyzeOptions): Promise<AnalysisResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  const [anchor] = await db.execute<{ conversation_id: string }>(sql`SELECT conversation_id FROM messages WHERE id = ${messageId}::uuid`);
  if (!anchor) return { outcome: 'no_message' };
  const conversationId = anchor.conversation_id;

  const [setting] = await db.select({ aiPaused: settings.aiPaused, ownerName: settings.ownerName, businessName: settings.businessName }).from(settings).where(eq(settings.id, 1)).limit(1);
  // The kill switch covers every AI call. Nothing is lost: the summary simply does not advance, and the next run covers these messages too.
  if (setting?.aiPaused) return { outcome: 'skipped_ai_paused' };

  const [conversation] = await db.select({ summary: conversations.summary, through: conversations.summaryThroughMessageId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversation) return { outcome: 'no_message' };

  const window = await loadWindow(db, conversationId, conversation.through);
  const newest = window.at(-1);
  if (!newest) return { outcome: 'nothing_new' };
  const lines = window.map((row) => ({ row, line: lineOf(row) })).filter((entry): entry is { row: WindowRow; line: AnalysisLine } => entry.line !== null);
  // Nothing readable (only photos with no caption, unreliable voice notes): do not call the model, and do not advance past them either.
  if (lines.length === 0) return { outcome: 'nothing_new' };

  const readTasks = await openTasksOf(db, conversationId);
  const context: AnalysisContext = {
    ownerName: setting?.ownerName ?? '',
    businessName: setting?.businessName ?? '',
    ownerTimezone: getEnv().OWNER_TIMEZONE,
    now,
    previousSummary: conversation.summary,
    openTasks: readTasks,
    messages: lines.map((entry) => entry.line),
  };

  const modelId = chatModelId('analysis');
  const reasoning = reasoningFor(modelId);
  let output: AnalysisOutput;
  try {
    const result = await runStructured({
      purpose: 'analysis',
      modelId,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      schema: analysisOutputSchema,
      instructions: analysisInstructions(context),
      prompt: analysisUserPrompt(context),
      temperature: 0.2,
      ...(reasoning ? { reasoning } : {}),
      db,
    });
    output = result.output;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    logger.warn({ error: error.name, conversationId }, 'post-send analysis failed');
    // Always rethrown: the queue retries it (3 attempts, backoff, a few seconds apart). Only the last attempt alerts.
    if (options.finalAttempt) await alertFailure(error, conversationId, now);
    throw error;
  }

  // ---- apply, under the conversation lock, against the state as it is NOW.
  const applied = await db.transaction(async (tx): Promise<{ outcome: 'applied'; data: Applied } | { outcome: 'already_covered' }> => {
    const [locked] = await tx.select({ through: conversations.summaryThroughMessageId }).from(conversations).where(eq(conversations.id, conversationId)).for('update');
    if (!locked) return { outcome: 'already_covered' };
    if (locked.through !== conversation.through) {
      // Someone else (a concurrent job) advanced the summary. If it already covers our newest message there is nothing left to do;
      // if not, our answer was written against an out-of-date summary: start over rather than overwrite a newer one.
      const [covers] = await tx.execute<{ covered: boolean }>(sql`
        SELECT (t.occurred_at, t.id) >= (n.occurred_at, n.id) AS covered
        FROM messages t, messages n
        WHERE t.id = ${locked.through}::uuid AND n.id = ${newest.id}::uuid
      `);
      if (covers?.covered) return { outcome: 'already_covered' };
      throw new AnalysisStaleError();
    }

    const open = await openTasksOf(tx, conversationId);
    const { accepted, rejected } = planOperations(output.operations, open, now);
    const rejectedCounts: Partial<Record<RejectReason, number>> = {};
    for (const entry of rejected) rejectedCounts[entry.reason] = (rejectedCounts[entry.reason] ?? 0) + 1;

    const sources = {
      customer: lines.findLast((entry) => entry.line.from === 'customer')?.row.id ?? null,
      owner: lines.findLast((entry) => entry.line.from === 'owner')?.row.id ?? null,
    };
    const changes = await applyPlan(tx, conversationId, accepted, sources, newest.id);
    await tx.update(conversations).set({ summary: output.summary.trim() || conversation.summary, summaryThroughMessageId: newest.id }).where(eq(conversations.id, conversationId));

    const effects: Effect[] = [{ type: 'publish', event: { type: 'conversation:updated', payload: { conversationId } } }];
    for (const taskId of [...changes.created, ...changes.completed, ...changes.updated]) effects.push({ type: 'publish', event: { type: 'task:changed', payload: { taskId, conversationId } } });
    return { outcome: 'applied', data: { ...changes, rejected: rejectedCounts, effects } };
  });

  if (applied.outcome === 'already_covered') return { outcome: 'already_covered' };
  await runEffects(applied.data.effects);
  const { created, completed, updated, rejected } = applied.data;
  if (Object.keys(rejected).length > 0) logger.info({ conversationId, rejected }, 'analysis operations rejected');
  return { outcome: 'applied', created: created.length, completed: completed.length, updated: updated.length, rejected };
}
