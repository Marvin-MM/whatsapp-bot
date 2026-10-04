import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/**
 * Inbound media is untrusted bytes that the owner's browser will later open. Three rules follow from that:
 *   1. only an allowlist of MIME types is stored (no HTML, no SVG, no executables: they are script vectors);
 *   2. the file's extension comes from the MIME type we verified, never from a filename or URL the sender controls;
 *   3. a stored path can never leave the media directory.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

interface AllowedType {
  kind: MediaKind;
  extension: string;
}

const MIB = 1024 * 1024;

/** Our own ceilings (WhatsApp's are higher). A file over its ceiling is refused before and while it is downloaded. */
export const MEDIA_MAX_BYTES: Readonly<Record<MediaKind, number>> = {
  image: 8 * MIB,
  video: 32 * MIB,
  audio: 16 * MIB,
  document: 25 * MIB,
  sticker: 2 * MIB,
};

/** Normalised (lowercase, no parameters) MIME type -> kind and the extension we store it under. */
const ALLOWED: Readonly<Record<string, AllowedType>> = {
  'image/jpeg': { kind: 'image', extension: 'jpg' },
  'image/png': { kind: 'image', extension: 'png' },
  'image/webp': { kind: 'image', extension: 'webp' },
  'image/gif': { kind: 'image', extension: 'gif' },
  'video/mp4': { kind: 'video', extension: 'mp4' },
  'video/3gpp': { kind: 'video', extension: '3gp' },
  'video/quicktime': { kind: 'video', extension: 'mov' },
  'audio/ogg': { kind: 'audio', extension: 'ogg' },
  'audio/opus': { kind: 'audio', extension: 'opus' },
  'audio/mpeg': { kind: 'audio', extension: 'mp3' },
  'audio/mp4': { kind: 'audio', extension: 'm4a' },
  'audio/aac': { kind: 'audio', extension: 'aac' },
  'audio/amr': { kind: 'audio', extension: 'amr' },
  'application/pdf': { kind: 'document', extension: 'pdf' },
  'text/plain': { kind: 'document', extension: 'txt' },
  'text/csv': { kind: 'document', extension: 'csv' },
  'application/msword': { kind: 'document', extension: 'doc' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'document', extension: 'docx' },
  'application/vnd.ms-excel': { kind: 'document', extension: 'xls' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'document', extension: 'xlsx' },
  'application/vnd.ms-powerpoint': { kind: 'document', extension: 'ppt' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'document', extension: 'pptx' },
};

/** `audio/ogg; codecs=opus` -> `audio/ogg`. Returns null for anything that is not a plausible MIME type. */
export function normalizeMime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.split(';')[0]?.trim().toLowerCase();
  return base && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(base) ? base : null;
}

export type MimeCheck = { ok: true; mime: string; kind: MediaKind; extension: string } | { ok: false; reason: 'mime_missing' | 'mime_not_allowed' | 'kind_mismatch' };

/**
 * Whether we will store a file of this MIME type. `expected` is the message type the webhook said it was: a "sticker" that
 * claims to be a PDF is refused rather than trusted. Stickers are WebP images, so a sticker may be image/webp.
 */
export function checkMime(raw: string | null | undefined, expected: MediaKind): MimeCheck {
  const mime = normalizeMime(raw);
  if (mime === null) return { ok: false, reason: 'mime_missing' };
  const allowed = ALLOWED[mime];
  if (!allowed) return { ok: false, reason: 'mime_not_allowed' };
  const matches = allowed.kind === expected || (expected === 'sticker' && mime === 'image/webp');
  return matches ? { ok: true, mime, kind: expected, extension: allowed.extension } : { ok: false, reason: 'kind_mismatch' };
}

/** The upper bound for a media kind. */
export const maxBytesFor = (kind: MediaKind): number => MEDIA_MAX_BYTES[kind];

export type HashCheck = 'match' | 'mismatch' | 'not_provided';

/**
 * Meta describes a file's SHA-256 inconsistently across surfaces (hex in the Graph media object, base64 in some webhook
 * payloads), so the digest is accepted in either encoding. A provided hash that matches neither means the bytes are not
 * the file Meta described: truncated, corrupted or substituted.
 */
export function verifySha256(bytes: Uint8Array, expected: string | null | undefined): HashCheck {
  const wanted = expected?.trim();
  if (!wanted) return 'not_provided';
  const digest = createHash('sha256').update(bytes).digest();
  return wanted.toLowerCase() === digest.toString('hex') || wanted === digest.toString('base64') ? 'match' : 'mismatch';
}

/** `{yyyy}/{mm}/{id}.{ext}` in UTC. The id is ours (a UUID), so nothing the sender controls reaches the path. */
export function mediaRelativePath(now: Date, id: string, extension: string): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}/${month}/${id}.${extension}`;
}

/**
 * Resolves a stored relative path against the media root and proves it stays inside it. Throws on an absolute path, a
 * traversal, a NUL byte or a backslash: a stored path is never trusted, even though we wrote it, because it also comes
 * back out of the database into a file read.
 */
export function resolveMediaPath(root: string, stored: string): string {
  if (stored === '' || stored.includes('\0') || stored.includes('\\') || isAbsolute(stored)) throw new Error('invalid media path');
  const normalised = normalize(stored);
  if (normalised.split(sep).includes('..')) throw new Error('invalid media path');
  const base = resolve(root);
  const full = resolve(join(base, normalised));
  const rel = relative(base, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid media path');
  return full;
}
