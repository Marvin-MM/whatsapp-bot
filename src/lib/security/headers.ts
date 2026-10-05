/**
 * Security headers (spec section 11). Pure functions: the proxy (pages, per-request nonce) and `next.config.ts` (API routes, fixed
 * values) both use these values, and a test keeps the two in step.
 */

/** Headers that never vary by request. Sent on every page and every API response. */
export const BASE_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'same-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
];

/** One year, including subdomains. Only ever sent when the app itself is served over https. */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

const NONCE_BYTES = 16;

/** 128 random bits, base64. A new one for every request: a reused nonce is no nonce. */
export function createNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface CspOptions {
  nonce: string;
  /** `next dev` needs `eval` (React rebuilds server stacks in the browser) and a websocket for hot reload. Never true in production. */
  development: boolean;
  /** Served over https: ask browsers to upgrade any stray http subresource. Left off on http (localhost), where it would break loading. */
  https: boolean;
}

/**
 * The page policy.
 *
 *  - Scripts run only with this request's nonce (`strict-dynamic` lets those scripts load their own chunks). No `unsafe-inline`, no host lists.
 *  - Styles: stylesheet files from this origin and `<style>` elements carrying the nonce. Inline `style="..."` ATTRIBUTES are allowed via
 *    `style-src-attr`, and only because Recharts' ResponsiveContainer renders one (`style="width:100%;height:220px"`) in server-rendered HTML
 *    (found by dropping the exemption and loading /analytics in Chromium). An attribute can carry no script, which is why scripts get no such
 *    exemption. Our own code has none: test/unit/no-inline-styles.test.ts keeps it that way, so the exemption stays for that one library.
 *  - Everything else (images, media, audio, fetch/SSE/server actions) is this origin only: media is served by our authenticated route.
 *  - No plugins, no framing, no `<base>` rewriting, forms post only to ourselves.
 */
export function buildCsp({ nonce, development, https }: CspOptions): string {
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `media-src 'self'`,
    `connect-src 'self'${development ? ' ws:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/** Sets every non-nonce header on a response. HSTS only when the app is served over https. */
export function applyBaseHeaders(headers: Headers, options: { https: boolean }): void {
  for (const [name, value] of BASE_SECURITY_HEADERS) headers.set(name, value);
  if (options.https) headers.set('Strict-Transport-Security', HSTS_VALUE);
}
