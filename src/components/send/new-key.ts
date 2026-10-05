/**
 * One idempotency key per composed message. `crypto.randomUUID` exists only in secure contexts (https, localhost): the dashboard
 * is also opened over a plain-http LAN address in development, so fall back to getRandomValues, which works everywhere.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
