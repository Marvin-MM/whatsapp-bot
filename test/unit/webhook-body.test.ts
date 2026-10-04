import { describe, expect, it } from 'vitest';
import { WEBHOOK_MAX_BODY_BYTES, readBodyCapped } from '@/lib/whatsapp/body';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
  });
}

function requestWith(body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/webhooks/whatsapp', {
    method: 'POST',
    headers,
    ...(body ? { body, duplex: 'half' } : {}),
  } as RequestInit);
}

const zeros = (n: number) => new Uint8Array(n);

describe('readBodyCapped', () => {
  it('uses a 3 MiB default (raised from the spec’s 1 MB so large history chunks are not lost)', () => {
    expect(WEBHOOK_MAX_BODY_BYTES).toBe(3 * 1024 * 1024);
  });

  it('returns the exact bytes for a small body', async () => {
    const result = await readBodyCapped(requestWith(streamOf([new TextEncoder().encode('{"a":'), new TextEncoder().encode('1}')])), 100);
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.bytes)).toBe('{"a":1}');
  });

  it('accepts a body of exactly the cap and rejects one byte more', async () => {
    expect((await readBodyCapped(requestWith(streamOf([zeros(1000)])), 1000)).ok).toBe(true);
    expect(await readBodyCapped(requestWith(streamOf([zeros(1001)])), 1000)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects on Content-Length alone, without reading the stream', async () => {
    let pulled = false;
    // highWaterMark 0: the stream pulls only when something actually reads it (otherwise it pre-fills eagerly).
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(zeros(10));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const result = await readBodyCapped(requestWith(body, { 'content-length': '999999' }), 1000);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    expect(pulled).toBe(false);
  });

  it('is not fooled by a Content-Length that understates the real size: the stream is counted', async () => {
    const result = await readBodyCapped(requestWith(streamOf([zeros(600), zeros(600)]), { 'content-length': '10' }), 1000);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('stops reading once the cap is exceeded (does not buffer the rest)', async () => {
    let chunksRead = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(zeros(400));
        if (chunksRead > 50) controller.close();
      },
    });
    const result = await readBodyCapped(requestWith(body), 1000);
    expect(result.ok).toBe(false);
    expect(chunksRead).toBeLessThan(10);
  });

  it('ignores a garbage Content-Length header and still enforces the cap by counting', async () => {
    expect((await readBodyCapped(requestWith(streamOf([zeros(10)]), { 'content-length': 'banana' }), 100)).ok).toBe(true);
    expect((await readBodyCapped(requestWith(streamOf([zeros(200)]), { 'content-length': 'banana' }), 100)).ok).toBe(false);
  });

  it('returns an empty body for a request with none', async () => {
    const result = await readBodyCapped(requestWith(null), 100);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.byteLength).toBe(0);
  });
});
