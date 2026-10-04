import 'server-only';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { type Db, getDb } from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { normalizeMime, resolveMediaPath } from '@/lib/whatsapp/media';

export type ByteRange = { start: number; end: number };

/**
 * A single `bytes=` range against a file of `size` bytes. `null` = no Range header (serve everything); `'invalid'` = the
 * header is malformed or unsatisfiable (416). Multi-range requests are refused rather than half-implemented.
 */
export function parseRange(header: string | null, size: number): ByteRange | 'invalid' | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) return 'invalid';
  const [, from = '', to = ''] = match;
  if (from === '' && to === '') return 'invalid';
  if (from === '') {
    // bytes=-N: the last N bytes.
    const suffix = Number(to);
    if (suffix === 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'invalid';
  return { start, end };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Headers for untrusted bytes opened in the owner's browser: the type is the one we VERIFIED against the allowlist (never
 * sniffed), `nosniff` forbids the browser second-guessing it, the CSP `sandbox` strips scripting from anything opened as a
 * page, and documents download instead of rendering.
 */
function baseHeaders(mime: string, extension: string, inline: boolean): Headers {
  return new Headers({
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': inline ? 'inline' : `attachment; filename="download.${extension}"`,
  });
}

/**
 * Serves one stored media file. The caller has ALREADY authorised the owner (the route does, per the "every route handler
 * verifies the session itself" rule); this only resolves and streams. Returns 404 for anything not servable: an unknown
 * id, a message without a file, a message the customer deleted, a path that fails the traversal check, a missing file.
 */
export async function serveMedia(request: Request, id: string, options: { db?: Db; root?: string } = {}): Promise<Response> {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  if (!UUID.test(id)) return notFound();

  const db = options.db ?? getDb();
  const [row] = await db
    .select({ mediaPath: messages.mediaPath, mediaMime: messages.mediaMime, deletedAt: messages.deletedAt, type: messages.type })
    .from(messages)
    .where(eq(messages.id, id))
    .limit(1);
  if (!row || row.mediaPath === null || row.deletedAt !== null) return notFound();

  const mime = normalizeMime(row.mediaMime);
  if (mime === null) return notFound();

  const root = options.root ?? getEnv().MEDIA_STORAGE_DIR;
  let fullPath: string;
  try {
    fullPath = resolveMediaPath(root, row.mediaPath);
  } catch {
    return notFound();
  }
  // The check above is lexical. Resolve symlinks too, so a link planted inside the media directory cannot lead the
  // server out of it (nothing in the pipeline ever creates one, but the directory is on disk and an operator may).
  const [realFile, realRoot] = await Promise.all([realpath(fullPath).catch(() => null), realpath(root).catch(() => null)]);
  if (realFile === null || realRoot === null || !realFile.startsWith(realRoot + sep)) return notFound();
  const info = await stat(realFile).catch(() => null);
  if (info === null || !info.isFile()) return notFound();

  const extension = row.mediaPath.split('.').pop() ?? 'bin';
  const headers = baseHeaders(mime, extension, row.type !== 'document');
  const range = parseRange(request.headers.get('range'), info.size);

  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(info.size));
    return new Response(null, { status: 200, headers });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, info.size - 1);
  headers.set('Content-Length', String(info.size === 0 ? 0 : end - start + 1));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  const body = info.size === 0 ? null : (Readable.toWeb(createReadStream(realFile, { start, end })) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status: range ? 206 : 200, headers });
}
