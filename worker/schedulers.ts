import type { Queue } from 'bullmq';
import type { ScheduledJobName } from '@/lib/queue/names';

export interface SchedulerDefinition {
  id: ScheduledJobName;
  repeat: { every: number } | { pattern: string; tz: string };
}

/**
 * Recurring jobs on the `scheduled` queue. Phases append here:
 * sweep-webhook-events and alerts-scan every 5 min, token-health and purge-payloads daily,
 * autopilot-digest daily in the owner's evening (pattern + tz).
 */
export const SCHEDULER_DEFINITIONS: readonly SchedulerDefinition[] = [
  { id: 'sweep-webhook-events', repeat: { every: 5 * 60 * 1000 } },
];

/**
 * Makes the queue's job schedulers exactly match `definitions`: upsert is idempotent across restarts,
 * and schedulers that were removed from code are removed from Redis too.
 */
export async function registerSchedulers(queue: Queue, definitions: readonly SchedulerDefinition[]): Promise<void> {
  await Promise.all(definitions.map((definition) => queue.upsertJobScheduler(definition.id, definition.repeat, { name: definition.id, data: {} })));
  const wanted = new Set<string>(definitions.map((definition) => definition.id));
  const existing = await queue.getJobSchedulers();
  await Promise.all(existing.filter((scheduler) => !wanted.has(scheduler.key)).map((scheduler) => queue.removeJobScheduler(scheduler.key)));
}
