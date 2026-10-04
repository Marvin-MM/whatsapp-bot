import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

/** `sha256=` + hex HMAC-SHA256 of the raw body, keyed with the app secret (what Meta sends in X-Hub-Signature-256). */
export function computeSignature(appSecret: string, body: Uint8Array): string {
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
}

/**
 * Verifies X-Hub-Signature-256 over the exact bytes that arrived. Never throws: any malformed input is simply "not valid".
 *
 * The body MUST be the raw bytes. Verifying a re-serialised JSON string would reject valid requests (whitespace, key
 * order) and, worse, could be made to accept an altered payload that happens to serialise identically.
 */
export function verifySignature(appSecret: string, body: Uint8Array, header: string | null | undefined): boolean {
  try {
    if (!header) return false;
    const match = SIGNATURE_PATTERN.exec(header.trim());
    if (!match?.[1]) return false;
    const received = Buffer.from(match[1], 'hex');
    const expected = createHmac('sha256', appSecret).update(body).digest();
    // The regex guarantees 32 bytes, but keep the length guard: timingSafeEqual throws on unequal lengths.
    return received.length === expected.length && timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

/** Constant-time string comparison for shared secrets (verify tokens). Unequal lengths are simply unequal. */
export function safeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
