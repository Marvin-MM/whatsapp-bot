import { afterEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_META_ERROR_CODES, classifyMetaError } from '@/lib/whatsapp/errors';
import { addressing, buildTemplatePayload, buildTextPayload, classifyNetworkError, classifyResponse, postMessage } from '@/lib/whatsapp/send-api';

afterEach(() => vi.unstubAllGlobals());

const PHONE = { phone: '+256700123456', bsuid: null };
const BSUID = { phone: null, bsuid: 'UG.99999999999999999999' };
const metaError = (code: number, message = 'x') => JSON.stringify({ error: { message, type: 'OAuthException', code, fbtrace_id: 'abc' } });
const accepted = JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: '256700123456', wa_id: '256700123456' }], messages: [{ id: 'wamid.HBgM' }] });

describe('addressing', () => {
  it('uses `to` (digits, no plus) for a phone and omits `recipient`', () => {
    expect(addressing(PHONE)).toEqual({ to: '256700123456' });
    expect(addressing({ phone: '+256 700-123 456', bsuid: 'UG.1' })).toEqual({ to: '256700123456' }); // phone wins; never both
  });

  it('uses `recipient` for a BSUID-only customer and omits `to`', () => {
    expect(addressing(BSUID)).toEqual({ recipient: 'UG.99999999999999999999' });
  });

  it('has nothing for nobody', () => {
    expect(addressing({ phone: null, bsuid: null })).toBeNull();
  });
});

describe('payloads', () => {
  it('builds a text payload that carries OUR message id as the callback data, with link previews off', () => {
    expect(buildTextPayload(PHONE, 'Hello', 'msg-id-1')).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '256700123456',
      type: 'text',
      text: { body: 'Hello', preview_url: false },
      biz_opaque_callback_data: 'msg-id-1',
    });
  });

  it('never supplies both `to` and `recipient`', () => {
    expect(buildTextPayload(BSUID, 'Hi', 'm')).not.toHaveProperty('to');
    expect(buildTextPayload(BSUID, 'Hi', 'm')).toHaveProperty('recipient', 'UG.99999999999999999999');
    expect(buildTextPayload(PHONE, 'Hi', 'm')).not.toHaveProperty('recipient');
  });

  it('builds a template payload', () => {
    const payload = buildTemplatePayload(PHONE, { name: 'order_update', language: 'en_US', components: [{ type: 'body', parameters: [{ type: 'text', text: 'A-17' }] }] }, 'm');
    expect(payload).toMatchObject({ type: 'template', template: { name: 'order_update', language: { code: 'en_US' }, components: [{ type: 'body' }] }, biz_opaque_callback_data: 'm' });
  });

  it('refuses to build a payload with nobody to send to', () => {
    expect(() => buildTextPayload({ phone: null, bsuid: null }, 'x', 'm')).toThrow('no recipient');
  });
});

describe('classifyResponse: when it is safe to try again, and when it is not', () => {
  it('accepts a 2xx with a message id', () => {
    expect(classifyResponse(200, accepted)).toEqual({ kind: 'accepted', wamid: 'wamid.HBgM' });
  });

  it.each([
    ['a 2xx with no body', 200, null],
    ['a 2xx that is not JSON', 200, 'OK'],
    ['a 2xx with no message id', 200, JSON.stringify({ messages: [] })],
    ['a 2xx whose message id is empty', 200, JSON.stringify({ messages: [{ id: '' }] })],
  ])('treats %s as AMBIGUOUS: it may have been sent', (_label, status, body) => {
    expect(classifyResponse(status, body).kind).toBe('ambiguous');
  });

  it('retries only what Meta says it did not do', () => {
    expect(classifyResponse(429, null).kind).toBe('retry');
    expect(classifyResponse(400, metaError(131056)).kind).toBe('retry'); // pair rate limit
    expect(classifyResponse(400, metaError(130429)).kind).toBe('retry');
    expect(classifyResponse(500, metaError(131016)).kind).toBe('retry'); // a 5xx WITH a Meta error body
    expect(classifyResponse(503, metaError(999999)).kind).toBe('retry'); // unknown code, 5xx, but Meta wrote a body
  });

  it('treats a 5xx WITHOUT a Meta body as AMBIGUOUS (a proxy or a crash: the request may have been processed)', () => {
    for (const body of [null, '', '<html>Bad gateway</html>', '{"not":"meta"}']) {
      expect(classifyResponse(502, body).kind, String(body)).toBe('ambiguous');
    }
    expect(classifyResponse(500, null).kind).toBe('ambiguous');
  });

  it('never retries a refusal', () => {
    for (const code of [131047, 131026, 131049, 132015, 190, 100, 131048, 131031]) {
      expect(classifyResponse(400, metaError(code)).kind, String(code)).toBe('permanent');
    }
    expect(classifyResponse(400, null).kind).toBe('permanent');
    expect(classifyResponse(404, '{}').kind).toBe('permanent');
  });

  it('keeps Meta’s code on the stored error and gives the owner a sentence', () => {
    const outcome = classifyResponse(400, metaError(131047));
    expect(outcome.kind).toBe('permanent');
    if (outcome.kind === 'permanent') {
      expect(outcome.error).toMatchObject({ kind: 'permanent', code: '131047' });
      expect(outcome.error.message).toContain('template');
    }
  });

  it('attaches an alert to the failures that need the owner beyond this one message', () => {
    const alertOf = (code: number) => {
      const outcome = classifyResponse(400, metaError(code));
      return outcome.kind === 'permanent' ? outcome.alert : undefined;
    };
    expect(alertOf(190)).toMatchObject({ kind: 'whatsapp_token_invalid', severity: 'critical' });
    expect(alertOf(131031)).toMatchObject({ severity: 'critical' });
    expect(alertOf(131048)).toMatchObject({ kind: 'whatsapp_spam_restricted' });
    expect(alertOf(131047)).toBeUndefined();
  });

  it('shows an unrecognised error raw and does NOT retry it', () => {
    const outcome = classifyResponse(400, metaError(7777777));
    expect(outcome.kind).toBe('permanent');
    if (outcome.kind === 'permanent') {
      expect(outcome.error.code).toBe('7777777');
      expect(outcome.error.message).toContain('7777777');
    }
  });
});

describe('classifyNetworkError: could the request have reached Meta?', () => {
  const failure = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED'])(
    '%s: the connection was never made, so it is safe to retry',
    (code) => {
      expect(classifyNetworkError(failure(code)).kind).toBe('retry');
    },
  );

  it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT', 'SOMETHING_NEW'])(
    '%s: the request may have been written, so it is AMBIGUOUS and never retried',
    (code) => {
      expect(classifyNetworkError(failure(code)).kind).toBe('ambiguous');
    },
  );

  it('treats our own timeout / abort as ambiguous, with a message that tells the owner what to do', () => {
    for (const name of ['TimeoutError', 'AbortError']) {
      const outcome = classifyNetworkError(Object.assign(new Error('x'), { name }));
      expect(outcome.kind).toBe('ambiguous');
      if (outcome.kind === 'ambiguous') expect(outcome.error.message).toContain('mark it sent or resend');
    }
  });

  it('treats an error with no code at all as ambiguous (never assume it did not send)', () => {
    expect(classifyNetworkError(new Error('who knows')).kind).toBe('ambiguous');
    expect(classifyNetworkError('a string').kind).toBe('ambiguous');
    expect(classifyNetworkError(null).kind).toBe('ambiguous');
  });
});

describe('the error table', () => {
  it('classifies every known code, with a readable message', () => {
    expect(KNOWN_META_ERROR_CODES.length).toBeGreaterThan(30);
    for (const code of KNOWN_META_ERROR_CODES) {
      const info = classifyMetaError(code, 400);
      expect(['retry', 'permanent']).toContain(info.kind);
      expect(info.message.length, String(code)).toBeGreaterThan(15);
      expect(info.message.endsWith('.'), String(code)).toBe(true);
    }
  });

  it('retries throttling and nothing else it knows', () => {
    const retries = KNOWN_META_ERROR_CODES.filter((code) => classifyMetaError(code, 400).kind === 'retry').sort((a, b) => a - b);
    expect(retries).toEqual([4, 17, 32, 613, 80007, 130429, 131016, 131056]);
  });

  it('falls back to HTTP semantics for an unknown code, and to permanent otherwise', () => {
    expect(classifyMetaError(9999, 429).kind).toBe('retry');
    expect(classifyMetaError(9999, 503).kind).toBe('retry');
    expect(classifyMetaError(9999, 400).kind).toBe('permanent');
    expect(classifyMetaError(null, 400).kind).toBe('permanent');
  });

  it('knows the window error by name', () => {
    expect(classifyMetaError(131047, 400).message).toMatch(/24 hours/);
  });
});

describe('postMessage (network stubbed)', () => {
  const stub = (impl: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const spy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(impl(String(input), init as RequestInit)));
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  it('POSTs JSON to the phone number’s /messages endpoint with the token in the header only', async () => {
    const spy = stub(() => new Response(accepted, { status: 200 }));
    const payload = buildTextPayload(PHONE, 'Hello', 'm-1');
    expect(await postMessage(payload)).toEqual({ kind: 'accepted', wamid: 'wamid.HBgM' });

    const [url, init] = spy.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://graph.facebook.com/v25.0/100000000000001/messages');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');
    expect(init?.body).not.toContain('test-access-token');
    expect(JSON.parse(String(init?.body))).toEqual(payload);
  });

  it('turns a thrown network error into a classification instead of throwing', async () => {
    stub(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    });
    expect((await postMessage({})).kind).toBe('retry');

    stub(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    expect((await postMessage({})).kind).toBe('ambiguous');
  });

  it('treats a body that cannot be read after a success status as ambiguous', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
      },
    });
    stub(() => new Response(stream, { status: 200 }));
    expect((await postMessage({})).kind).toBe('ambiguous');
  });
});
