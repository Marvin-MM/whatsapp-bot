import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/events/route';
import { getEnv } from '@/lib/env';
import { closeProducerConnection, getProducerConnection } from '@/lib/queue/connection';
import { uuidv7 } from '@/lib/ids';
import { type DashboardEvent, dashboardChannel } from '@/lib/realtime/events';
import { closeDashboardHub, createDashboardHub } from '@/lib/realtime/hub';
import { publishEvent } from '@/lib/realtime/publish';
import { SSE_HEADERS, activeStreams, eventStreamResponse } from '@/lib/realtime/sse';
import { createEnrolledOwner } from '../helpers/auth';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';
import { cleanupPrefix, createTestRedis, uniquePrefix } from '../helpers/redis';

const prefix = uniquePrefix();
process.env.BULLMQ_PREFIX = prefix;

const hubs: Array<ReturnType<typeof createDashboardHub>> = [];
let cleaner: Redis;
let admin: ReturnType<typeof migratorSql>;

beforeAll(() => {
  cleaner = createTestRedis();
  admin = migratorSql();
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
  // Every stream must have been released by its test: a leak here would starve the cap in later tests.
  expect(activeStreams()).toBe(0);
});

afterAll(async () => {
  await closeDashboardHub();
  await closeProducerConnection();
  await cleanupPrefix(cleaner, prefix);
  await cleaner.quit();
  await closeAllDb();
});

const channel = () => dashboardChannel(prefix);
function newHub() {
  const hub = createDashboardHub(getEnv().REDIS_URL, channel());
  hubs.push(hub);
  return hub;
}

const sample = (): Extract<DashboardEvent, { type: 'message:new' }>['payload'] => ({ conversationId: uuidv7(), messageId: uuidv7() });
const until = async (condition: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 15));
  return condition();
};

/** Reads a stream into a growing string, so a test can wait for text to appear. */
function collect(response: Response) {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const state = { text: '', done: false };
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) {
        state.done = true;
        return;
      }
      state.text += decoder.decode(value);
    }
  })();
  return { state, cancel: () => reader.cancel().catch(() => undefined) };
}

const events = (text: string): DashboardEvent[] =>
  text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)) as DashboardEvent);

describe('the dashboard hub', () => {
  it('fans a published event out to every listener, validated', async () => {
    const hub = newHub();
    const a: DashboardEvent[] = [];
    const b: DashboardEvent[] = [];
    await hub.subscribe((event) => a.push(event));
    await hub.subscribe((event) => b.push(event));

    const payload = sample();
    await publishEvent({ type: 'message:new', payload });
    expect(await until(() => a.length === 1 && b.length === 1)).toBe(true);
    expect(a[0]).toMatchObject({ type: 'message:new', payload });
    expect(hub.size()).toBe(2);
  });

  it('stops delivering to a listener once it unsubscribes', async () => {
    const hub = newHub();
    const kept: DashboardEvent[] = [];
    const dropped: DashboardEvent[] = [];
    await hub.subscribe((event) => kept.push(event));
    const stop = await hub.subscribe((event) => dropped.push(event));
    stop();
    expect(hub.size()).toBe(1);

    await publishEvent({ type: 'conversation:updated', payload: { conversationId: uuidv7() } });
    expect(await until(() => kept.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dropped).toHaveLength(0);
  });

  it('DROPS anything that is not a valid event, even when something else puts it on the channel: no message body can pass through', async () => {
    const hub = newHub();
    const got: DashboardEvent[] = [];
    await hub.subscribe((event) => got.push(event));

    const producer = getProducerConnection();
    const bad = [
      'not json at all',
      '{}',
      JSON.stringify({ type: 'message:new', payload: { conversationId: uuidv7(), messageId: uuidv7(), body: 'private customer text' }, at: new Date().toISOString() }),
      JSON.stringify({ type: 'carrier:pigeon', payload: {}, at: new Date().toISOString() }),
      JSON.stringify({ type: 'conversation:updated', payload: { conversationId: 'not-a-uuid' }, at: new Date().toISOString() }),
    ];
    for (const raw of bad) await producer.publish(channel(), raw);
    await publishEvent({ type: 'conversation:updated', payload: { conversationId: uuidv7() } }); // a good one after them, as a marker

    expect(await until(() => got.length >= 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(got).toHaveLength(1);
    expect(JSON.stringify(got)).not.toContain('private customer text');
  });

  it('a throwing listener does not stop the others', async () => {
    const hub = newHub();
    const got: DashboardEvent[] = [];
    await hub.subscribe(() => {
      throw new Error('listener bug');
    });
    await hub.subscribe((event) => got.push(event));
    await publishEvent({ type: 'conversation:updated', payload: { conversationId: uuidv7() } });
    expect(await until(() => got.length === 1)).toBe(true);
  });
});

describe('eventStreamResponse', () => {
  it('speaks text/event-stream with the headers that keep it unbuffered, and forwards events as data lines', async () => {
    const hub = newHub();
    const controller = new AbortController();
    const response = eventStreamResponse({ hub, signal: controller.signal });

    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(SSE_HEADERS)) expect(response.headers.get(name), name).toBe(value);
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const { state } = collect(response);
    expect(await until(() => state.text.includes('retry: 3000'))).toBe(true);
    expect(state.text).toContain(': connected');

    const payload = sample();
    await until(() => hub.size() === 1);
    await publishEvent({ type: 'message:new', payload });
    expect(await until(() => events(state.text).length === 1)).toBe(true);
    expect(events(state.text)[0]).toMatchObject({ type: 'message:new', payload });
    controller.abort();
  });

  it('keeps an idle stream alive with a heartbeat comment', async () => {
    const controller = new AbortController();
    const { state } = collect(eventStreamResponse({ hub: newHub(), signal: controller.signal, heartbeatMs: 40 }));
    expect(await until(() => (state.text.match(/: ping/g) ?? []).length >= 3)).toBe(true);
    controller.abort();
  });

  it('releases everything when the client goes away', async () => {
    const hub = newHub();
    const controller = new AbortController();
    const response = eventStreamResponse({ hub, signal: controller.signal });
    const { state } = collect(response);
    expect(await until(() => hub.size() === 1)).toBe(true);
    expect(activeStreams()).toBe(1);

    controller.abort();
    expect(await until(() => state.done)).toBe(true);
    expect(await until(() => hub.size() === 0)).toBe(true);
    expect(activeStreams()).toBe(0);
  });

  it('releases everything when the reader cancels (the browser closed the tab)', async () => {
    const hub = newHub();
    const response = eventStreamResponse({ hub, signal: new AbortController().signal });
    const { cancel } = collect(response);
    expect(await until(() => hub.size() === 1)).toBe(true);
    await cancel();
    expect(await until(() => hub.size() === 0 && activeStreams() === 0)).toBe(true);
  });

  it('handles a client that is already gone before the stream starts', async () => {
    const hub = newHub();
    const controller = new AbortController();
    controller.abort();
    const { state } = collect(eventStreamResponse({ hub, signal: controller.signal }));
    expect(await until(() => state.done)).toBe(true);
    expect(activeStreams()).toBe(0);
  });

  it('refuses a stream beyond the cap with 503 and Retry-After, and accepts again once one closes', async () => {
    const hub = newHub();
    const a = new AbortController();
    const b = new AbortController();
    const first = eventStreamResponse({ hub, signal: a.signal, maxStreams: 2 });
    const second = eventStreamResponse({ hub, signal: b.signal, maxStreams: 2 });
    collect(first);
    collect(second);

    const refused = eventStreamResponse({ hub, signal: new AbortController().signal, maxStreams: 2 });
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(activeStreams()).toBe(2); // a refused request holds nothing

    a.abort();
    expect(await until(() => activeStreams() === 1)).toBe(true);
    const c = new AbortController();
    const again = eventStreamResponse({ hub, signal: c.signal, maxStreams: 2 });
    expect(again.status).toBe(200);
    collect(again);
    expect(activeStreams()).toBe(2);
    b.abort();
    c.abort();
    expect(await until(() => activeStreams() === 0)).toBe(true);
  });

  it('ends the stream when the session is no longer valid, or when the re-check itself fails', async () => {
    const hub = newHub();
    const revoked = collect(eventStreamResponse({ hub, signal: new AbortController().signal, recheck: async () => false, recheckMs: 30 }));
    expect(await until(() => revoked.state.done)).toBe(true);

    const broken = collect(
      eventStreamResponse({
        hub,
        signal: new AbortController().signal,
        recheck: async () => {
          throw new Error('database down');
        },
        recheckMs: 30,
      }),
    );
    expect(await until(() => broken.state.done)).toBe(true);
    expect(await until(() => activeStreams() === 0)).toBe(true);
  });

  it('keeps a valid session open across re-checks', async () => {
    let checks = 0;
    const controller = new AbortController();
    const { state } = collect(
      eventStreamResponse({
        hub: newHub(),
        signal: controller.signal,
        recheck: async () => {
          checks += 1;
          return true;
        },
        recheckMs: 30,
      }),
    );
    expect(await until(() => checks >= 3)).toBe(true);
    expect(state.done).toBe(false);
    controller.abort();
  });

  it('drops a reader that stops reading instead of buffering for it forever', async () => {
    const hub = newHub();
    const response = eventStreamResponse({ hub, signal: new AbortController().signal, heartbeatMs: 5 });
    // Never read the body: the heartbeat alone fills the queue past the backlog limit.
    expect(await until(() => activeStreams() === 0, 8000)).toBe(true);
    await response.body?.cancel().catch(() => undefined);
  });

  it('closes cleanly when the hub cannot subscribe', async () => {
    const failing = { subscribe: () => Promise.reject(new Error('redis is down')), size: () => 0, close: async () => undefined };
    const { state } = collect(eventStreamResponse({ hub: failing, signal: new AbortController().signal }));
    expect(await until(() => state.done)).toBe(true);
    expect(activeStreams()).toBe(0);
  });
});

describe('GET /api/events', () => {
  it('answers 401 with no body to anyone who is not the signed-in owner', async () => {
    await resetDb(admin);
    for (const headers of [{}, { cookie: 'better-auth.session_token=forged.value' }] as Array<Record<string, string>>) {
      const response = await GET(new Request('http://localhost:3000/api/events', { headers }));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
    }
    expect(activeStreams()).toBe(0);
  });

  it('streams events to the authenticated owner', async () => {
    await resetDb(admin);
    const owner = await createEnrolledOwner();
    const controller = new AbortController();
    const response = await GET(new Request('http://localhost:3000/api/events', { headers: { cookie: owner.cookie }, signal: controller.signal }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const { state } = collect(response);
    expect(await until(() => state.text.includes('retry: 3000'))).toBe(true);
    const payload = sample();
    // The hub's subscription is asynchronous; publish until the stream reports it.
    await until(() => {
      void publishEvent({ type: 'message:new', payload });
      return events(state.text).length > 0;
    });
    expect(events(state.text)[0]).toMatchObject({ type: 'message:new', payload });
    controller.abort();
    expect(await until(() => activeStreams() === 0)).toBe(true);
  });
});
