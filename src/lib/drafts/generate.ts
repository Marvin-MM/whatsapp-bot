import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { raiseAlert } from '@/lib/alerts';
import { runAutopilotForDraft } from '@/lib/autopilot/decide';
import { generateDraftFromContext, loadDraftContext } from '@/lib/ai/draft';
import { AiProviderError } from '@/lib/ai/errors';
import { DRAFT_PROMPT_VERSION } from '@/lib/ai/prompts/draft';
import { chatModelId } from '@/lib/ai/models';
import { type Db, getDb } from '@/lib/db';
import { conversations, drafts, settings } from '@/lib/db/schema';
import { type Effect, runEffects } from '@/lib/ingest/effects';
import { logger } from '@/lib/logger';
import { notifyDraftReady } from '@/lib/notify/draft-ready';
import { supersedeOpenDrafts, supersededEffects } from './supersede';
import { draftTriggerEffect } from './trigger';
import { loadUnanswered, sameIds } from './unanswered';

/**
 * `generate-draft` (spec 6.6, 9): write ONE draft for everything the customer has sent since the owner last spoke.
 *
 *   1. AI paused -> nothing (the inbox keeps working; the owner can still reply by hand or press "Draft a reply" after resuming).
 *   2. Waiting on a voice note's transcript -> try again shortly (up to MAX_WAITS), then draft anyway and flag the media as unreadable.
 *   3. Context -> ONE model call (one corrective retry inside the wrapper) -> code-side checks.
 *   4. COMPLETION CHECK, under the conversation lock: the unanswered set must be exactly what the model was shown. A message that arrived (or
 *      a reply the owner sent from the phone) while the model was thinking makes this draft out of date: it is DISCARDED, and the job that the
 *      newer message started drafts again. (Without this the older of two overlapping generations could finish last and win.)
 *   5. Save the draft `pending`, supersede anything older, tell the dashboard, then (after commit) the owner's phone.
 *
 * Failures never block the owner: a draft the model could not produce is stored as `failed` so the page can offer "Regenerate", and the
 * conversation can always be answered by hand.
 */

export const MAX_WAITS = 8;
export const WAIT_SECONDS = 8;

export type GenerateOutcome =
  | 'created'
  | 'no_reply_needed'
  | 'skipped_ai_paused'
  | 'skipped_nothing_to_answer'
  | 'skipped_duplicate'
  | 'waiting_for_transcription'
  | 'discarded_stale'
  | 'failed';

export interface GenerateResult {
  outcome: GenerateOutcome;
  draftId?: string;
}

export interface GenerateOptions {
  finalAttempt: boolean;
  /** How many times this conversation's job has already waited for a transcript. */
  waits?: number;
  now?: Date;
  db?: Db;
}

async function insertFailed(db: Db, conversationId: string, ids: readonly string[], model: string, error: Error): Promise<{ draftId: string | null; effects: Effect[] }> {
  return db.transaction(async (tx) => {
    await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).for('update');
    // The conversation moved on while we failed: a newer job will try again, a "failed" row now would only be noise.
    if (!sameIds((await loadUnanswered(tx, conversationId)).map((m) => m.id), ids)) return { draftId: null, effects: [] };
    const existing = await tx
      .select({ id: drafts.id, trigger: drafts.triggerMessageIds })
      .from(drafts)
      .where(and(eq(drafts.conversationId, conversationId), eq(drafts.status, 'failed')));
    const duplicate = existing.find((row) => sameIds(row.trigger, ids));
    if (duplicate) return { draftId: duplicate.id, effects: [] };
    const [row] = await tx
      .insert(drafts)
      .values({
        conversationId,
        triggerMessageIds: [...ids],
        content: '',
        originalContent: '',
        intent: 'other',
        // The error NAME only: what the model or the customer wrote never goes in here.
        analysis: `The draft could not be generated (${error.name}).`,
        model,
        promptVersion: DRAFT_PROMPT_VERSION,
        status: 'failed',
      })
      .returning({ id: drafts.id });
    if (!row) throw new Error('failed-draft insert returned nothing');
    return { draftId: row.id, effects: [{ type: 'publish', event: { type: 'draft:updated', payload: { conversationId, draftId: row.id, status: 'failed' } } }] };
  });
}

export async function generateDraftForConversation(conversationId: string, options: GenerateOptions): Promise<GenerateResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  const [setting] = await db.select({ aiPaused: settings.aiPaused }).from(settings).where(eq(settings.id, 1)).limit(1);
  if (setting?.aiPaused) return { outcome: 'skipped_ai_paused' };

  const unanswered = await loadUnanswered(db, conversationId);
  if (unanswered.length === 0) return { outcome: 'skipped_nothing_to_answer' };
  const ids = unanswered.map((message) => message.id);

  const open = await db
    .select({ id: drafts.id, trigger: drafts.triggerMessageIds })
    .from(drafts)
    .where(and(eq(drafts.conversationId, conversationId), inArray(drafts.status, ['pending', 'scheduled'])));
  const existing = open.find((row) => sameIds(row.trigger, ids));
  if (existing) return { outcome: 'skipped_duplicate', draftId: existing.id };

  const waiting = unanswered.some((message) => message.type === 'audio' && message.transcription === 'pending');
  const waits = options.waits ?? 0;
  if (waiting && waits < MAX_WAITS) {
    await runEffects([draftTriggerEffect(conversationId, { delaySeconds: WAIT_SECONDS, waits: waits + 1 })]);
    return { outcome: 'waiting_for_transcription' };
  }

  const modelId = chatModelId('draft');
  let result;
  let loaded;
  try {
    loaded = await loadDraftContext(db, { conversationId, burstMessageIds: ids, now });
    // A transcript that never arrived is as unreadable as one that came back unreliable.
    result = await generateDraftFromContext(db, { context: loaded.context, unreadableMedia: loaded.unreadableMedia || waiting });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const retryable = error instanceof AiProviderError && error.retryable;
    // A provider outage is retried by the queue; only the last attempt gives up.
    if (retryable && !options.finalAttempt) throw error;
    logger.warn({ error: error.name, conversationId }, 'draft generation failed');
    const failed = await insertFailed(db, conversationId, ids, modelId, error);
    await runEffects(failed.effects);
    if (error instanceof AiProviderError && (error.status === 401 || error.status === 403)) {
      await raiseAlert({ kind: 'ai_key_invalid', severity: 'critical', dedupeKey: `ai_key_invalid:${now.toISOString().slice(0, 10)}` });
    } else {
      await raiseAlert({ kind: 'draft_generation_failed', severity: 'warning', entityId: conversationId, dedupeKey: `draft_generation_failed:${conversationId}:${now.toISOString().slice(0, 13)}` });
    }
    return { outcome: 'failed', ...(failed.draftId ? { draftId: failed.draftId } : {}) };
  }

  const saved = await db.transaction(async (tx): Promise<{ outcome: GenerateOutcome; draftId?: string; effects: Effect[] }> => {
    await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, conversationId)).for('update');
    const [again] = await tx.select({ aiPaused: settings.aiPaused }).from(settings).where(eq(settings.id, 1)).limit(1);
    if (again?.aiPaused) return { outcome: 'skipped_ai_paused', effects: [] };
    if (!sameIds((await loadUnanswered(tx, conversationId)).map((m) => m.id), ids)) return { outcome: 'discarded_stale', effects: [] };

    const effects: Effect[] = [];
    effects.push(...supersededEffects(conversationId, await supersedeOpenDrafts(tx, conversationId), 'Not sent: a newer draft replaced it.'));
    const { output } = result;
    const [row] = await tx
      .insert(drafts)
      .values({
        conversationId,
        triggerMessageIds: ids,
        content: output.reply,
        originalContent: output.reply,
        intent: output.intent,
        analysis: output.analysis,
        missingFacts: output.missingFacts,
        // `missing_facts_unmarked` is ours, not the model's: the draft names a missing fact but wrote no [[placeholder]] for it (spec 9.3).
        riskFlags: result.missingFactsUnmarked ? [...output.riskFlags, 'missing_facts_unmarked'] : output.riskFlags,
        noReplyNeeded: output.noReplyNeeded,
        model: result.model,
        promptVersion: result.promptVersion,
        styleGuideVersion: loaded.styleGuideVersion,
        fewshotMessageIds: loaded.fewshotMessageIds,
        status: 'pending',
      })
      .returning({ id: drafts.id });
    if (!row) throw new Error('draft insert returned nothing');
    if (!output.noReplyNeeded) effects.push({ type: 'publish', event: { type: 'draft:ready', payload: { conversationId, draftId: row.id } } });
    effects.push({ type: 'publish', event: { type: 'conversation:updated', payload: { conversationId } } });
    return { outcome: output.noReplyNeeded ? 'no_reply_needed' : 'created', draftId: row.id, effects };
  });

  try {
    await runEffects(saved.effects);
    if ((saved.outcome === 'created' || saved.outcome === 'no_reply_needed') && saved.draftId) {
      // In a conversation on autopilot the draft is judged now (never throws, never sends). A draft it takes over (a countdown is running, or a
      // plain "ok" was closed) needs no "ready for approval" ping; everything else is an ordinary draft.
      const autopilot = await runAutopilotForDraft(db, saved.draftId, now);
      const takenOver = autopilot.kind === 'scheduled' || autopilot.kind === 'closed_no_reply';
      // A phone buzz is for a draft that needs a decision, never for "ok" / "thanks".
      if (saved.outcome === 'created' && !takenOver) await notifyDraftReady(db, { conversationId, draftId: saved.draftId, now });
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'draft effects failed');
  }
  return { outcome: saved.outcome, ...(saved.draftId ? { draftId: saved.draftId } : {}) };
}
