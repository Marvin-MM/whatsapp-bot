import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { raiseAlert, registerAlertSink } from '@/lib/alerts';
import { getEnv } from '@/lib/env';
import { closeProducerConnection } from '@/lib/queue/connection';
import { dashboardChannel, parseDashboardEvent } from '@/lib/realtime/events';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';
import { createTestRedis, uniquePrefix } from '../helpers/redis';

process.env.BULLMQ_PREFIX = uniquePrefix();

let admin: Sql;
let subscriber: Redis;
const received: string[] = [];
const sunk: string[] = [];

beforeAll(async () => {
  admin = migratorSql();
  subscriber = createTestRedis();
  subscriber.on('message', (_channel: string, message: string) => received.push(message));
  await subscriber.subscribe(dashboardChannel(getEnv().BULLMQ_PREFIX));
  registerAlertSink(async (alert) => void sunk.push(alert.kind));
});

beforeEach(async () => {
  await resetDb(admin);
  received.length = 0;
  sunk.length = 0;
});

afterAll(async () => {
  await subscriber.quit();
  await closeProducerConnection();
  await closeAllDb();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('raiseAlert', () => {
  it('records the alert, publishes one dashboard event with no body, and fans out to sinks', async () => {
    expect(await raiseAlert({ kind: 'account_partner_removed', severity: 'critical', entityId: 'waba-1', dedupeKey: 'acct:1' })).toBe(true);
    await settle();

    const rows = await admin<{ kind: string }[]>`SELECT kind FROM notifications`;
    expect(rows.map((row) => row.kind)).toEqual(['alert:account_partner_removed']);
    expect(received).toHaveLength(1);
    expect(parseDashboardEvent(received[0] ?? '')).toMatchObject({ type: 'alert', payload: { kind: 'account_partner_removed', entityId: 'waba-1' } });
    expect(sunk).toEqual(['account_partner_removed']);
  });

  it('raises each dedupe key once: the second call changes nothing and notifies nobody', async () => {
    await raiseAlert({ kind: 'x', severity: 'warning', dedupeKey: 'same' });
    await settle();
    received.length = 0;
    sunk.length = 0;

    expect(await raiseAlert({ kind: 'x', severity: 'warning', dedupeKey: 'same' })).toBe(false);
    await settle();
    expect(received).toHaveLength(0);
    expect(sunk).toHaveLength(0);
    expect((await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications`)[0]?.n).toBe(1);
  });

  it('treats different keys as different alerts', async () => {
    await raiseAlert({ kind: 'x', severity: 'info', dedupeKey: 'a' });
    await raiseAlert({ kind: 'x', severity: 'info', dedupeKey: 'b' });
    expect((await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications`)[0]?.n).toBe(2);
  });

  it('never throws, even when a sink fails', async () => {
    registerAlertSink(async () => {
      throw new Error('telegram is down');
    });
    await expect(raiseAlert({ kind: 'y', severity: 'info', dedupeKey: 'resilient' })).resolves.toBe(true);
  });
});
