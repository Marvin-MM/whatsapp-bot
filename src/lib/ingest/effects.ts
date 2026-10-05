import 'server-only';
import type { JobsOptions } from 'bullmq';
import { type AlertInput, raiseAlert } from '@/lib/alerts';
import { retireAutopilotDraft } from '@/lib/autopilot/telegram';
import { getDb } from '@/lib/db';
import { logger } from '@/lib/logger';
import { enqueue } from '@/lib/queue/enqueue';
import type { QueueName } from '@/lib/queue/names';
import type { DashboardEventInput } from '@/lib/realtime/events';
import { publishEvent } from '@/lib/realtime/publish';

/**
 * Side effects a handler wants AFTER its transaction commits. Handlers never touch Redis or Telegram inside the
 * transaction: a rolled-back transaction must not leave an SSE event or a queued job behind.
 */
export type Effect =
  | { type: 'publish'; event: DashboardEventInput }
  | { type: 'enqueue'; queue: QueueName; name: string; data: unknown; opts?: JobsOptions }
  | { type: 'alert'; alert: AlertInput }
  /** A draft stopped being waiting-to-be-sent automatically: remove its countdown and take the buttons off its Telegram message. Best effort. */
  | { type: 'retire_autopilot'; draftId: string; note: string };

/**
 * Runs effects in a deliberate order. Enqueues come first and PROPAGATE failure (the processor job then retries, and
 * the handlers re-derive the enqueue from database state, so nothing is lost). SSE events are best-effort: the
 * dashboard also refreshes on reconnect, so a lost event never fails the job. Alerts and autopilot retirements never throw by contract.
 */
export async function runEffects(effects: readonly Effect[]): Promise<void> {
  for (const effect of effects) {
    if (effect.type === 'enqueue') await enqueue(effect.queue, effect.name, effect.data, effect.opts);
  }
  for (const effect of effects) {
    if (effect.type === 'publish') {
      await publishEvent(effect.event).catch((error: Error) =>
        logger.warn({ error: error.name, event: effect.event.type }, 'dashboard event not published'),
      );
    }
  }
  for (const effect of effects) {
    if (effect.type === 'alert') await raiseAlert(effect.alert);
  }
  for (const effect of effects) {
    if (effect.type === 'retire_autopilot') await retireAutopilotDraft(getDb(), effect.draftId, effect.note);
  }
}
