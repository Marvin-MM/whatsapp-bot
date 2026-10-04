import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { checkHealth } from '@/lib/health';
import { getProducerConnection } from '@/lib/queue/connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Unauthenticated liveness probe for the load balancer / compose healthcheck. Booleans only. */
export async function GET(): Promise<Response> {
  const result = await checkHealth({
    db: () => getDb().execute(sql`select 1`),
    redis: () => getProducerConnection().ping(),
  });
  return Response.json(result, { status: result.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
