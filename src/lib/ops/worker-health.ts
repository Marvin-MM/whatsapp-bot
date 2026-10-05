import 'server-only';
import type { Redis } from 'ioredis';
import { withDeadline } from '@/lib/async';

/**
 * Is the worker alive? The worker writes an ISO timestamp to a Redis key every 15 seconds with a 60-second expiry (`worker/runtime.ts`); the web
 * side only reads it. A missing key means no worker has beaten in the last minute (never started, crashed, or Redis was wiped), a stale one means
 * it is hung or Redis is slow: either way nothing is being sent, drafted or summarised, and the owner is told.
 */

export const HEARTBEAT_INTERVAL_SECONDS = 15;
export const HEARTBEAT_TTL_SECONDS = 60;
/** Three missed beats: a single slow beat is not an outage. */
export const WORKER_STALE_AFTER_SECONDS = HEARTBEAT_INTERVAL_SECONDS * 3;

export const heartbeatKey = (prefix: string): string => `${prefix}:worker:heartbeat`;

export interface WorkerHealth {
  alive: boolean;
  /** Seconds since the last beat; null when there has been none. */
  ageSeconds: number | null;
}

export function judgeHeartbeat(raw: string | null, now: Date): WorkerHealth {
  if (raw === null) return { alive: false, ageSeconds: null };
  const at = new Date(raw).getTime();
  if (Number.isNaN(at)) return { alive: false, ageSeconds: null };
  // A beat from the future (clock skew between machines) is treated as "just now", never as proof of life from tomorrow.
  const age = Math.max(0, Math.round((now.getTime() - at) / 1000));
  return { alive: age <= WORKER_STALE_AFTER_SECONDS, ageSeconds: age };
}

export async function readWorkerHealth(redis: Redis, prefix: string, now: Date = new Date()): Promise<WorkerHealth> {
  try {
    const raw = await withDeadline(redis.get(heartbeatKey(prefix)), 2000, () => new Error('redis timed out'));
    return judgeHeartbeat(raw, now);
  } catch {
    return { alive: false, ageSeconds: null };
  }
}
