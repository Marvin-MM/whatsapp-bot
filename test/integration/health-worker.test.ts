import { afterAll, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/health/worker/route';
import { getEnv } from '@/lib/env';
import { heartbeatKey } from '@/lib/ops/worker-health';
import { setupIngestHarness } from '../helpers/ingest';
import { createTestRedis } from '../helpers/redis';

setupIngestHarness();
const redis = createTestRedis();
afterAll(async () => {
  await redis.del(heartbeatKey(getEnv().BULLMQ_PREFIX));
  await redis.quit();
});
const key = () => heartbeatKey(getEnv().BULLMQ_PREFIX);

describe('GET /api/health/worker', () => {
  it('is 503 when no worker has beaten (the key is absent)', async () => {
    await redis.del(key());
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, ageSeconds: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is 200 with a fresh beat, and reports how old it is', async () => {
    await redis.set(key(), new Date(Date.now() - 4000).toISOString(), 'EX', 60);
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; ageSeconds: number };
    expect(body.ok).toBe(true);
    expect(body.ageSeconds).toBeGreaterThanOrEqual(3);
    expect(body.ageSeconds).toBeLessThanOrEqual(6);
  });

  it('is 503 when the beat is stale (a hung worker whose key has not yet expired)', async () => {
    await redis.set(key(), new Date(Date.now() - 50_000).toISOString(), 'EX', 60);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, ageSeconds: expect.any(Number) });
  });

  it('is 503 for garbage in the key, and needs no session (it is a probe) but reveals nothing else', async () => {
    await redis.set(key(), 'not a date', 'EX', 60);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(Object.keys((await response.json()) as object).sort()).toEqual(['ageSeconds', 'ok']);
  });
});
