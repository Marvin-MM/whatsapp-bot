/**
 * Postgres rejects U+0000 in `text` and in JSONB strings ("unsupported Unicode escape sequence"). A signed webhook
 * carrying one would make the INSERT fail, answer 500, and be retried by Meta for ~36 hours: a poison message that
 * also blocks the rest of its batch. Strip it before storage. Keys are cleaned as well as values.
 */
export function stripNulChars<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  if (Array.isArray(value)) return value.map(strip);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[strip(key) as string] = strip(inner);
    return out;
  }
  return value;
}
