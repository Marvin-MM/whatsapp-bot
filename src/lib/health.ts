import { withDeadline } from '@/lib/async';

export interface HealthProbes {
  db: () => PromiseLike<unknown>;
  redis: () => PromiseLike<unknown>;
}

export interface HealthResult {
  ok: boolean;
  db: boolean;
  redis: boolean;
}

export const PROBE_TIMEOUT_MS = 2000;

async function probe(run: () => PromiseLike<unknown>, timeoutMs: number): Promise<boolean> {
  try {
    await withDeadline(run(), timeoutMs, () => new Error('probe timed out'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Liveness of the dependencies the web app needs. Reports booleans only: a public, unauthenticated
 * endpoint must not reveal hostnames, versions or error text.
 */
export async function checkHealth(probes: HealthProbes, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<HealthResult> {
  const [db, redis] = await Promise.all([probe(probes.db, timeoutMs), probe(probes.redis, timeoutMs)]);
  return { ok: db && redis, db, redis };
}
