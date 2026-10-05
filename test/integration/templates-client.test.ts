import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnv } from '@/lib/env';
import { closeProducerConnection } from '@/lib/queue/connection';
import { TemplatesUnavailableError, fetchTemplates, loadTemplates, readCachedTemplates } from '@/lib/whatsapp/templates-client';
import { jsonResponse, stubNetwork } from '../helpers/network';
import { cleanupPrefix, createTestRedis, uniquePrefix } from '../helpers/redis';

const prefix = uniquePrefix();
process.env.BULLMQ_PREFIX = prefix;
const cleaner = createTestRedis();
beforeAll(() => getEnv());
beforeEach(() => cleanupPrefix(cleaner, prefix));
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await cleanupPrefix(cleaner, prefix);
  await cleaner.quit();
  await closeProducerConnection();
});

const tpl = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  language: 'en',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [{ type: 'BODY', text: 'Hi {{1}}' }],
  ...over,
});

describe('fetchTemplates', () => {
  it('asks the WABA for its templates with the token, and lists supported ones first', async () => {
    const net = stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl('zeta', { status: 'PAUSED' }), tpl('beta'), tpl('alpha')] }) });
    const list = await fetchTemplates();

    expect(list.map((t) => `${t.name}:${t.supported}`)).toEqual(['alpha:true', 'beta:true', 'zeta:false']);
    const url = new URL(net.templates[0] ?? '');
    expect(url.pathname).toBe('/v25.0/100000000000002/message_templates');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('fields')).toContain('components');
  });

  it('follows pagination on Graph, and ONLY on Graph (the request carries our token)', async () => {
    const net = stubNetwork({
      graphTemplates: (url) =>
        url.searchParams.get('after') === 'p2'
          ? jsonResponse({ data: [tpl('second')] })
          : jsonResponse({ data: [tpl('first')], paging: { next: 'https://graph.facebook.com/v25.0/100000000000002/message_templates?after=p2' } }),
    });
    expect((await fetchTemplates()).map((t) => t.name)).toEqual(['first', 'second']);
    expect(net.templates).toHaveLength(2);

    vi.unstubAllGlobals();
    const evil = stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl('only')], paging: { next: 'https://evil.example/steal?after=x' } }) });
    expect((await fetchTemplates()).map((t) => t.name)).toEqual(['only']);
    expect(evil.templates).toHaveLength(1);
  });

  it('skips a template in a shape we do not understand instead of failing the whole list', async () => {
    stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl('good'), { nonsense: true }, null] }) });
    expect((await fetchTemplates()).map((t) => t.name)).toEqual(['good']);
  });

  it.each([
    ['an HTTP error', () => jsonResponse({ error: { code: 190 } }, 401), /HTTP 401/],
    ['a non-JSON body', () => new Response('<html>', { status: 200 }), /could not read/],
    ['an unexpected shape', () => jsonResponse({ nope: 1 }), /shape/],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
      /Could not reach Meta/,
    ],
  ])('throws TemplatesUnavailableError on %s', async (_name, route, message) => {
    stubNetwork({ graphTemplates: route });
    await expect(fetchTemplates()).rejects.toThrow(TemplatesUnavailableError);
    await expect(fetchTemplates()).rejects.toThrow(message);
  });
});

describe('loadTemplates / readCachedTemplates', () => {
  const t0 = new Date('2026-10-05T10:00:00Z');

  it('caches for five minutes, refetches after, and the send-side reader never fetches', async () => {
    let version = 0;
    const net = stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl(`v${++version}`)] }) });

    expect(await readCachedTemplates()).toBeNull();
    expect(net.templates).toHaveLength(0);

    expect((await loadTemplates({ now: t0 })).templates[0]?.name).toBe('v1');
    expect((await loadTemplates({ now: new Date(t0.getTime() + 4 * 60 * 1000) })).templates[0]?.name).toBe('v1');
    expect(net.templates).toHaveLength(1);
    expect((await readCachedTemplates())?.templates[0]?.name).toBe('v1');

    expect((await loadTemplates({ now: new Date(t0.getTime() + 6 * 60 * 1000) })).templates[0]?.name).toBe('v2');
    expect((await loadTemplates({ now: new Date(t0.getTime() + 6 * 60 * 1000), force: true })).templates[0]?.name).toBe('v3');
    expect(net.templates).toHaveLength(3);
  });

  it('falls back to the stale copy when Meta is down, and says so', async () => {
    stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl('kept')] }) });
    await loadTemplates({ now: t0 });

    vi.unstubAllGlobals();
    stubNetwork({ graphTemplates: () => jsonResponse({}, 503) });
    const later = await loadTemplates({ now: new Date(t0.getTime() + 10 * 60 * 1000) });
    expect(later.stale).toBe(true);
    expect(later.templates[0]?.name).toBe('kept');
  });

  it('throws when there is no copy at all and Meta is down', async () => {
    stubNetwork({ graphTemplates: () => jsonResponse({}, 503) });
    await expect(loadTemplates({ now: t0 })).rejects.toThrow(TemplatesUnavailableError);
  });

  it('ignores a corrupted cache entry rather than trusting it', async () => {
    await cleaner.set(`${prefix}:templates:v1`, '{"fetchedAt":"nope","templates":"x"}');
    expect(await readCachedTemplates()).toBeNull();
    stubNetwork({ graphTemplates: () => jsonResponse({ data: [tpl('fresh')] }) });
    expect((await loadTemplates({ now: t0 })).templates[0]?.name).toBe('fresh');
  });
});
