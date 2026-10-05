import { readWorkerHealth } from '@/lib/ops/worker-health';
import { getEnv } from '@/lib/env';
import { getProducerConnection } from '@/lib/queue/connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Unauthenticated, like `/api/health`: the deploy's health check and an uptime monitor call it. Reports whether the worker has beaten recently
 * and how long ago, nothing else (no hostnames, versions or error text).
 */
export async function GET(): Promise<Response> {
  const health = await readWorkerHealth(getProducerConnection(), getEnv().BULLMQ_PREFIX);
  return Response.json({ ok: health.alive, ageSeconds: health.ageSeconds }, { status: health.alive ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
