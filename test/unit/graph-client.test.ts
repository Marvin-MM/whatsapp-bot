import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphError, assertPublicHttpsUrl, downloadMedia, getMediaInfo } from '@/lib/whatsapp/client';

const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123&ext=1';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failureOf(promise: Promise<unknown>): Promise<GraphError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphError) return error;
    throw error;
  }
  throw new Error('expected a GraphError');
}

describe('getMediaInfo', () => {
  it('looks the media up with the access token and returns what Meta says about it', async () => {
    const spy = stubFetch(() => json({ id: 'M1', url: MEDIA_URL, mime_type: 'image/jpeg', sha256: 'abc', file_size: '12345', messaging_product: 'whatsapp' }));
    const info = await getMediaInfo('M1');

    expect(info).toEqual({ url: MEDIA_URL, mimeType: 'image/jpeg', sha256: 'abc', fileSize: 12345 });
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://graph.facebook.com/v25.0/M1');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');
  });

  it('tolerates a response without the optional fields', async () => {
    stubFetch(() => json({ url: MEDIA_URL }));
    expect(await getMediaInfo('M1')).toEqual({ url: MEDIA_URL, mimeType: null, sha256: null, fileSize: null });
  });

  it.each([
    ['404', 404, {}, 'gone'],
    ['410', 410, {}, 'gone'],
    ['400 with Graph code 100 (object does not exist)', 400, { error: { code: 100 } }, 'gone'],
    ['401', 401, {}, 'auth'],
    ['403', 403, {}, 'auth'],
    ['Graph code 190 (token expired)', 400, { error: { code: 190 } }, 'auth'],
    ['429', 429, {}, 'retryable'],
    ['500', 500, {}, 'retryable'],
    ['503', 503, {}, 'retryable'],
    ['Graph rate-limit code 4', 400, { error: { code: 4 } }, 'retryable'],
    ['Graph code 130429', 400, { error: { code: 130429 } }, 'retryable'],
    ['any other 400', 400, { error: { code: 33 } }, 'permanent'],
  ])('classifies HTTP %s as %s', async (_label, status, body, expected) => {
    stubFetch(() => json(body, status));
    expect((await failureOf(getMediaInfo('M1'))).failure).toBe(expected);
  });

  it('classifies by status alone when the error body is not JSON (a CDN error page)', async () => {
    stubFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect((await failureOf(getMediaInfo('M1'))).failure).toBe('retryable');
  });

  it('treats a network failure and a timeout as retryable', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect((await failureOf(getMediaInfo('M1'))).failure).toBe('retryable');

    stubFetch(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    expect((await failureOf(getMediaInfo('M1'))).message).toContain('timed out');
  });

  it('refuses a media id that could rewrite the request path, before making any request', async () => {
    const spy = stubFetch(() => json({ url: MEDIA_URL }));
    for (const bad of ['../me', 'a/b', 'a?x=1', 'a b', '', 'x'.repeat(200)]) {
      expect((await failureOf(getMediaInfo(bad))).failure).toBe('permanent');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a malformed lookup response', async () => {
    stubFetch(() => json({ nothing: true }));
    expect((await failureOf(getMediaInfo('M1'))).failure).toBe('permanent');
  });

  it('refuses a lookup that points the download somewhere unsafe, so the token never leaves for an internal host', async () => {
    for (const url of ['http://lookaside.fbsbx.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://metadata.internal/x', 'https://printer.local/x', 'https://intranet/x']) {
      stubFetch(() => json({ url }));
      expect((await failureOf(getMediaInfo('M1'))).failure, url).toBe('permanent');
    }
  });
});

describe('assertPublicHttpsUrl', () => {
  it('accepts a normal public https url and rejects garbage', () => {
    expect(assertPublicHttpsUrl(MEDIA_URL).hostname).toBe('lookaside.fbsbx.com');
    expect(() => assertPublicHttpsUrl('not a url')).toThrow(GraphError);
    expect(() => assertPublicHttpsUrl('ftp://example.com/x')).toThrow(GraphError);
  });
});

describe('downloadMedia', () => {
  const bytes = (n: number) => new Uint8Array(n).fill(7);

  it('downloads with the token and returns the bytes and content type', async () => {
    const spy = stubFetch(() => new Response(bytes(10), { headers: { 'content-type': 'image/png', 'content-length': '10' } }));
    const result = await downloadMedia(MEDIA_URL, 100);
    expect(result.bytes).toEqual(bytes(10));
    expect(result.contentType).toBe('image/png');
    expect((spy.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');
  });

  it('refuses a file whose declared size is over the cap, without reading it', async () => {
    stubFetch(() => new Response(bytes(10), { headers: { 'content-length': '5000' } }));
    expect((await failureOf(downloadMedia(MEDIA_URL, 100))).failure).toBe('permanent');
  });

  it('refuses a file that LIES about its size: the cap is enforced while reading, so memory is never exhausted', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes(64));
      },
    });
    stubFetch(() => new Response(stream, { headers: { 'content-length': '10' } }));
    const error = await failureOf(downloadMedia(MEDIA_URL, 100));
    expect(error.failure).toBe('permanent');
    expect(error.message).toContain('larger than the allowed size');
  });

  it('classifies a failed download like a failed lookup', async () => {
    stubFetch(() => new Response('gone', { status: 404 }));
    expect((await failureOf(downloadMedia(MEDIA_URL, 100))).failure).toBe('gone');
    stubFetch(() => new Response('denied', { status: 401 }));
    expect((await failureOf(downloadMedia(MEDIA_URL, 100))).failure).toBe('auth');
  });

  it('treats a connection that dies mid-body as retryable', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(5));
        controller.error(new Error('connection reset'));
      },
    });
    stubFetch(() => new Response(stream));
    expect((await failureOf(downloadMedia(MEDIA_URL, 100))).failure).toBe('retryable');
  });

  it('never fetches an unsafe url', async () => {
    const spy = stubFetch(() => new Response(bytes(1)));
    expect((await failureOf(downloadMedia('http://127.0.0.1/secret', 100))).failure).toBe('permanent');
    expect(spy).not.toHaveBeenCalled();
  });
});
