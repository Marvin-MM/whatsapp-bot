/**
 * Returns `target` only if it is a same-origin path, otherwise the fallback.
 * Blocks open redirects such as `//evil.example`, `/\evil.example` and absolute URLs in `?next=`.
 */
export function safeRedirectPath(target: string | null | undefined, fallback = '/'): string {
  if (!target) return fallback;
  if (!target.startsWith('/')) return fallback;
  if (target.startsWith('//') || target.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f]/.test(target)) return fallback;
  return target;
}
