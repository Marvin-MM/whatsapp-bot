import 'server-only';
import { z } from 'zod';
import type { MessageError } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { GRAPH_ORIGIN } from './client';
import { digitsOf } from './phone';
import { type MetaErrorInfo, classifyMetaError } from './errors';

/**
 * The ONLY code that calls Meta's `/messages` endpoint. `src/lib/send/send-message.ts` is the only importer (a test enforces
 * it): every outbound message in the system therefore passes through the one transaction that claims it, pre-checks it and
 * stamps `send_started_at` BEFORE this is called.
 *
 * The contract of `postMessage` is a classification, never an exception: the caller must know whether Meta definitively
 * did not send the message (safe to retry) or MAY have (never retry: the Cloud API has no idempotency key, so a retry of an
 * ambiguous failure is a duplicate message to a customer).
 */

export const SEND_TIMEOUT_MS = 20_000;

export type SendOutcome =
  /** Meta accepted it and returned the message id. */
  | { kind: 'accepted'; wamid: string }
  /** Meta DEFINITIVELY did not send it (rate limit, 5xx with a Meta error body, connection never made): a later attempt may work. */
  | { kind: 'retry'; error: MessageError }
  /** Meta refused it and always will. */
  | { kind: 'permanent'; error: MessageError; alert?: MetaErrorInfo['alert'] }
  /** It may or may not have been sent. NEVER retried; the owner decides. */
  | { kind: 'ambiguous'; error: MessageError };

export interface Recipient {
  phone: string | null;
  bsuid: string | null;
}

/** Phone number when we have one (`to`), otherwise the BSUID (`recipient`, with `to` omitted): supplying both would let Meta pick. */
export function addressing(recipient: Recipient): { to: string } | { recipient: string } | null {
  if (recipient.phone) return { to: digitsOf(recipient.phone) };
  if (recipient.bsuid) return { recipient: recipient.bsuid };
  return null;
}

export interface TemplateToSend {
  name: string;
  /** BCP-47-ish code Meta uses, e.g. `en_US`. */
  language: string;
  components: ReadonlyArray<Record<string, unknown>>;
}

/** `callbackData` is our own message id: Meta returns it in the status webhook, so a status that beats our write of the wamid still matches. */
export function buildTextPayload(recipient: Recipient, body: string, callbackData: string): Record<string, unknown> {
  const address = addressing(recipient);
  if (!address) throw new Error('no recipient');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...address,
    type: 'text',
    text: { body, preview_url: false },
    biz_opaque_callback_data: callbackData,
  };
}

export function buildTemplatePayload(recipient: Recipient, template: TemplateToSend, callbackData: string): Record<string, unknown> {
  const address = addressing(recipient);
  if (!address) throw new Error('no recipient');
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...address,
    type: 'template',
    template: { name: template.name, language: { code: template.language }, components: template.components },
    biz_opaque_callback_data: callbackData,
  };
}

const successSchema = z.looseObject({ messages: z.array(z.looseObject({ id: z.string().min(1) })).min(1) });
const errorSchema = z.looseObject({
  error: z.looseObject({ code: z.number().optional(), message: z.string().optional(), error_data: z.looseObject({ details: z.string().optional() }).optional() }),
});

/** Where a network error happened decides whether the request could have reached Meta. */
const NEVER_SENT: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  // TLS handshake failures happen before a single byte of the request is written.
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'SELF_SIGNED_CERT_IN_CHAIN',
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  return errorCode((error as { cause?: unknown }).cause);
}

/** Exposed for the table-driven test. */
export function classifyNetworkError(error: unknown): SendOutcome {
  const code = errorCode(error);
  if (code !== undefined && NEVER_SENT.has(code)) {
    return { kind: 'retry', error: { kind: 'safe_retry', code: null, message: 'Could not connect to Meta. Retrying shortly.' } };
  }
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return {
    kind: 'ambiguous',
    error: {
      kind: 'ambiguous',
      code: null,
      message: timedOut
        ? 'Meta did not answer in time. The message may or may not have been sent: check your phone, then mark it sent or resend.'
        : 'The connection to Meta broke after the message was sent. It may or may not have been delivered: check your phone, then mark it sent or resend.',
    },
  };
}

/**
 * Turns Meta's HTTP answer into an outcome.
 *   2xx + message id            -> accepted
 *   2xx without a message id    -> ambiguous (it may have been sent)
 *   an error body Meta wrote    -> by its code: retry or permanent. A 5xx WITH a Meta error body is Meta saying "I did not do it"
 *   429                         -> retry (Meta throttled before processing)
 *   5xx WITHOUT a Meta body     -> ambiguous (a proxy or crash: the request may have been processed)
 *   any other 4xx               -> permanent
 */
export function classifyResponse(status: number, bodyText: string | null): SendOutcome {
  let json: unknown = null;
  try {
    json = bodyText === null ? null : (JSON.parse(bodyText) as unknown);
  } catch {
    json = null;
  }

  if (status >= 200 && status < 300) {
    const parsed = successSchema.safeParse(json);
    if (parsed.success) return { kind: 'accepted', wamid: parsed.data.messages[0]?.id ?? '' };
    return {
      kind: 'ambiguous',
      error: { kind: 'ambiguous', code: null, message: 'Meta answered, but not in a way we can read. The message may or may not have been sent: check your phone, then mark it sent or resend.' },
    };
  }

  const meta = errorSchema.safeParse(json);
  if (meta.success) {
    const code = meta.data.error.code ?? null;
    const info = classifyMetaError(code, status);
    const error: MessageError = { kind: info.kind === 'retry' ? 'safe_retry' : 'permanent', code: code === null ? null : String(code), message: info.message };
    return info.kind === 'retry' ? { kind: 'retry', error } : { kind: 'permanent', error, ...(info.alert ? { alert: info.alert } : {}) };
  }

  if (status === 429) {
    return { kind: 'retry', error: { kind: 'safe_retry', code: null, message: 'Meta is throttling requests. Retrying shortly.' } };
  }
  if (status >= 500) {
    return {
      kind: 'ambiguous',
      error: { kind: 'ambiguous', code: null, message: `Meta (or a proxy in front of it) failed with HTTP ${status} and no explanation. The message may or may not have been sent: check your phone, then mark it sent or resend.` },
    };
  }
  return { kind: 'permanent', error: { kind: 'permanent', code: null, message: `Meta refused the message (HTTP ${status}).` } };
}

/** Sends one message. Never throws for anything Meta or the network does; the outcome says what to do. */
export async function postMessage(payload: Record<string, unknown>): Promise<SendOutcome> {
  const env = getEnv();
  let response: Response;
  try {
    response = await globalThis.fetch(`${GRAPH_ORIGIN}/${env.META_GRAPH_VERSION}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    return classifyNetworkError(error);
  }
  let text: string | null = null;
  try {
    text = await response.text();
  } catch (error) {
    // Headers arrived but the body did not: for a success status that is ambiguous; for an error it is just "no body".
    if (response.ok) return classifyNetworkError(error);
  }
  return classifyResponse(response.status, text);
}
