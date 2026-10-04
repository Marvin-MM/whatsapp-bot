/**
 * Meta batches up to ~1,000 updates per POST and Coexistence history chunks can be large; a body rejected as too big
 * is retried for ~36 h and then lost, so the spec's 1 MB was raised to 3 MiB (D-032). The signature is still checked
 * before anything is parsed, and the cap is enforced before the body is buffered.
 */
export const WEBHOOK_MAX_BODY_BYTES = 3 * 1024 * 1024;

export type BodyResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' };

/**
 * Reads a request body with a hard byte cap. Checks Content-Length first (cheap rejection), then counts bytes while
 * streaming so a missing or lying Content-Length cannot make us buffer more than `maxBytes`.
 */
export async function readBodyCapped(request: Request, maxBytes: number = WEBHOOK_MAX_BODY_BYTES): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' };

  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
