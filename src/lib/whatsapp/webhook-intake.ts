import 'server-only';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { sha256Hex } from '@/lib/hash';
import { persistEvents } from '@/lib/ingest/persist';
import { logger } from '@/lib/logger';
import { enqueueBulk } from '@/lib/queue/enqueue';
import { readBodyCapped } from './body';
import { safeEqualStrings, verifySignature } from './signature';
import { parseEnvelope } from './webhook-schema';
import { type SplitItem, splitEnvelope } from './webhook-split';

export interface IntakeDeps {
  /** Stores events, returns the dedupe keys that still need processing. */
  persist: (items: SplitItem[]) => Promise<string[]>;
  /** Enqueues one process-webhook-event job per key. */
  enqueue: (keys: string[]) => Promise<void>;
}

const defaultDeps: IntakeDeps = {
  persist: (items) => persistEvents(getDb(), items),
  enqueue: async (keys) => {
    await enqueueBulk(
      'process-webhook-event',
      keys.map((key) => ({ name: 'process', data: { dedupeKey: key }, opts: { jobId: key } })),
    );
  },
};

// Rate-limited warnings: a flood of forged requests must not flood the logs.
const lastWarned = new Map<string, number>();
function warnRateLimited(key: string, message: string): void {
  const now = Date.now();
  if (now - (lastWarned.get(key) ?? 0) < 60_000) return;
  lastWarned.set(key, now);
  logger.warn({ reason: key }, message);
}

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * GET: Meta's subscription handshake. `hub.verify_token` is compared in constant time; the challenge is echoed as
 * text/plain so it can never be interpreted as markup.
 */
export function handleWebhookVerify(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode !== 'subscribe' || !token || challenge === null || !safeEqualStrings(token, getEnv().WEBHOOK_VERIFY_TOKEN)) {
    warnRateLimited('verify_rejected', 'webhook verification rejected');
    return new Response('Forbidden', { status: 403 });
  }
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/**
 * POST: persist-then-ack. In this order, and nothing else:
 *   1. read the body under a byte cap          -> 413
 *   2. verify X-Hub-Signature-256 over the raw bytes -> 401 (and NO database write, ever, for an unverified request)
 *   3. parse; wrong product / unparseable shape are handled without making Meta retry
 *   4. split into events, store every one (ON CONFLICT DO NOTHING), enqueue the unprocessed ones
 *   5. any storage or queue failure -> 500 so Meta retries (it retries for ~36 h); otherwise 200
 * No AI call and no other processing happens here: the response must be fast.
 */
export async function handleWebhookPost(request: Request, deps: IntakeDeps = defaultDeps): Promise<Response> {
  const body = await readBodyCapped(request);
  if (!body.ok) {
    warnRateLimited('too_large', 'webhook body over the size cap');
    return json({ error: 'payload_too_large' }, 413);
  }

  if (!verifySignature(getEnv().META_APP_SECRET, body.bytes, request.headers.get('x-hub-signature-256'))) {
    warnRateLimited('bad_signature', 'webhook signature rejected');
    return json({ error: 'invalid_signature' }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const parsed = parseEnvelope(payload);
  let items: SplitItem[];
  if (parsed.ok) {
    items = splitEnvelope(parsed.envelope);
  } else if (parsed.reason === 'not_json_object') {
    return json({ error: 'invalid_payload' }, 400);
  } else if (parsed.reason === 'wrong_object') {
    // Signed by our app secret but for another Meta product: nothing for us to do, and a 4xx would only cause retries.
    logger.info({ object: parsed.object ?? 'missing' }, 'webhook for another object ignored');
    return json({ ignored: true }, 200);
  } else {
    // Right product, shape we cannot parse: keep the raw payload (lossless) and let the processor raise an alert.
    items = [
      {
        dedupeKey: `other:envelope:${sha256Hex(body.bytes)}`,
        kind: 'other',
        item: { field: 'envelope', value: payload, parseError: true },
      },
    ];
  }

  if (items.length === 0) return json({ received: 0 }, 200);

  try {
    const pending = await deps.persist(items);
    if (pending.length > 0) await deps.enqueue(pending);
    logger.info({ events: items.length, enqueued: pending.length }, 'webhook received');
    return json({ received: items.length }, 200);
  } catch (error) {
    // Rows already stored stay stored (and the sweeper re-enqueues them); this only tells Meta to retry.
    logger.error({ error: error instanceof Error ? error.name : 'unknown', events: items.length }, 'webhook storage or queue failure');
    return json({ error: 'temporarily_unavailable' }, 500);
  }
}
