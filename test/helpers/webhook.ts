import { computeSignature } from '@/lib/whatsapp/signature';
import { fixtureBytes } from './fixtures';

export const WEBHOOK_URL = 'http://localhost:3000/api/webhooks/whatsapp';

export function appSecret(): string {
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error('META_APP_SECRET is not set (test/setup/env.ts should have provided it)');
  return secret;
}

export function verifyToken(): string {
  const token = process.env.WEBHOOK_VERIFY_TOKEN;
  if (!token) throw new Error('WEBHOOK_VERIFY_TOKEN is not set');
  return token;
}

export interface SignedOptions {
  /** Overrides the signature header; `null` omits it. */
  signature?: string | null;
  headers?: Record<string, string>;
  secret?: string;
}

/** A POST exactly as Meta sends it: raw bytes in the body, HMAC of those bytes in X-Hub-Signature-256. */
export function signedRequest(body: Uint8Array | string, options: SignedOptions = {}): Request {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
  const signature = options.signature === undefined ? computeSignature(options.secret ?? appSecret(), bytes) : options.signature;
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  // `new Uint8Array(bytes)` copies into an ArrayBuffer-backed view, which is what BodyInit accepts.
  return new Request(WEBHOOK_URL, { method: 'POST', headers, body: new Uint8Array(bytes) });
}

export function fixtureRequest(name: string, options: SignedOptions = {}): Request {
  return signedRequest(fixtureBytes(name), options);
}

export function verifyRequest(params: Record<string, string>): Request {
  return new Request(`${WEBHOOK_URL}?${new URLSearchParams(params).toString()}`, { method: 'GET' });
}
