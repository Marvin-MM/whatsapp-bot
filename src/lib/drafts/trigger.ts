import 'server-only';
import type { Effect } from '@/lib/ingest/effects';
import { getEnv } from '@/lib/env';
import { enqueue } from '@/lib/queue/enqueue';

/**
 * Which customer messages a draft is written for (spec 6.7): everything the owner would answer. Reactions, system notices and
 * unsupported types are not answered; a voice note counts once its transcript is ready (or has been judged unusable).
 */
export const DRAFT_TRIGGER_TYPES = ['text', 'image', 'video', 'document', 'sticker', 'audio', 'location', 'contacts', 'interactive', 'button'] as const;

export interface DraftJobData {
  conversationId: string;
  /** How many times this job has already waited for a voice note to be transcribed. */
  waits?: number;
  /** Started by the owner (Regenerate, "Draft a reply"): not waiting for a quiet moment. */
  manual?: boolean;
}

/**
 * The BullMQ options that make a burst of messages ONE draft (spec 6.6): one deduplication id per conversation in debounce mode, so each new
 * message replaces the waiting job and restarts the timer. A message that arrives while a job is already RUNNING makes a second job instead
 * (observed, bullmq-spike): `generate-draft` therefore re-checks at completion whether the conversation moved on, and discards if it did.
 */
export function draftJobOptions(conversationId: string, delayMs: number) {
  return { delay: delayMs, deduplication: { id: `draft:${conversationId}`, ttl: Math.max(delayMs, 1000), extend: true, replace: true } } as const;
}

/** After commit, from the ingest handlers: draft this conversation once the customer has stopped typing. */
export function draftTriggerEffect(conversationId: string, options: { delaySeconds?: number; waits?: number } = {}): Effect {
  const delayMs = (options.delaySeconds ?? getEnv().DRAFT_DEBOUNCE_SECONDS) * 1000;
  const data: DraftJobData = { conversationId, ...(options.waits ? { waits: options.waits } : {}) };
  return { type: 'enqueue', queue: 'generate-draft', name: 'draft', data, opts: draftJobOptions(conversationId, delayMs) };
}

/** From the owner's actions: draft now. */
export async function enqueueDraftNow(conversationId: string): Promise<void> {
  const data: DraftJobData = { conversationId, manual: true };
  await enqueue('generate-draft', 'draft', data, draftJobOptions(conversationId, 0));
}
