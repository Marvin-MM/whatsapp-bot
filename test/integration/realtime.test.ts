import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeProducerConnection } from '@/lib/queue/connection';
import { uuidv7 } from '@/lib/ids';
import { dashboardChannel, parseDashboardEvent } from '@/lib/realtime/events';
import { publishEvent } from '@/lib/realtime/publish';
import { getEnv } from '@/lib/env';
import { createTestRedis } from '../helpers/redis';

let subscriber: Redis;
const received: string[] = [];
const channel = () => dashboardChannel(getEnv().BULLMQ_PREFIX);

beforeAll(async () => {
  subscriber = createTestRedis();
  subscriber.on('message', (_channel: string, message: string) => received.push(message));
  await subscriber.subscribe(channel());
});

afterAll(async () => {
  await subscriber.quit();
  await closeProducerConnection();
});

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('publishEvent', () => {
  it('delivers a validated, timestamped event to subscribers of the prefixed dashboard channel', async () => {
    received.length = 0;
    const conversationId = uuidv7();
    const messageId = uuidv7();
    await publishEvent({ type: 'message:new', payload: { conversationId, messageId } });
    await waitFor(() => received.length > 0);

    expect(received).toHaveLength(1);
    const event = parseDashboardEvent(received[0] ?? '');
    expect(event).toMatchObject({ type: 'message:new', payload: { conversationId, messageId } });
    expect(Number.isNaN(Date.parse(event?.at ?? ''))).toBe(false);
  });

  it('refuses a malformed event and publishes nothing (a bug must fail loudly, not leak bodies)', async () => {
    received.length = 0;
    const leaky = { type: 'message:new', payload: { conversationId: uuidv7(), messageId: uuidv7(), body: 'private text' } };
    await expect(publishEvent(leaky as unknown as Parameters<typeof publishEvent>[0])).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toHaveLength(0);
  });
});
