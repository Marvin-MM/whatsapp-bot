import 'server-only';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { AiProviderError } from '@/lib/ai/errors';
import { transcribeVoiceNote, transcriptContent } from '@/lib/ai/transcribe';
import { type Db, getDb } from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { GraphError, downloadMedia, getMediaInfo } from '@/lib/whatsapp/client';
import { type MediaKind, checkMime, maxBytesFor, mediaRelativePath, resolveMediaPath, verifySha256 } from '@/lib/whatsapp/media';
import { runEffects } from './effects';

export type MediaOutcome = 'stored' | 'already_stored' | 'no_media' | 'unavailable' | 'message_missing';

export interface MediaJobOptions {
  /** The last BullMQ attempt: stop retrying and settle in a visible "unavailable / failed" state. */
  finalAttempt: boolean;
  db?: Db;
  now?: Date;
  /** Overrides MEDIA_STORAGE_DIR (tests). */
  root?: string;
}

const LABEL: Readonly<Record<MediaKind, string>> = { image: 'Image', video: 'Video', audio: 'Voice message', document: 'Document', sticker: 'Sticker' };
const KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio', 'document', 'sticker']);

const isKind = (value: string): value is MediaKind => KINDS.has(value);

type MessageRow = typeof messages.$inferSelect;

/**
 * Terminal "this file will never arrive" state: `media_id` is cleared (so nothing re-enqueues it and the UI can tell
 * "gone" from "not downloaded yet"), a placeholder-only content becomes "[Image unavailable]", and a pending transcript
 * becomes failed. Real content (a caption, the customer's words) is never overwritten.
 */
async function markUnavailable(db: Db, row: MessageRow, kind: MediaKind, reason: string): Promise<void> {
  const placeholder = row.contentSource === 'rendered' && (row.content?.startsWith('[') ?? false);
  await db
    .update(messages)
    .set({
      mediaId: null,
      ...(placeholder ? { content: `[${LABEL[kind]} unavailable]` } : {}),
      ...(row.transcriptionStatus === 'pending' ? { transcriptionStatus: 'failed' as const } : {}),
    })
    .where(and(eq(messages.id, row.id), isNull(messages.mediaPath)));
  logger.info({ messageId: row.id, reason }, 'media marked unavailable');
}

/** Writes through a temp file in the same directory and renames: a reader never sees a half-written file. */
async function saveAtomically(fullPath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true });
  const temp = `${fullPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { mode: 0o640 });
    await rename(temp, fullPath);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function alertBadToken(now: Date): Promise<void> {
  await runEffects([
    {
      type: 'alert',
      alert: { kind: 'whatsapp_token_invalid', severity: 'critical', dedupeKey: `whatsapp_token_invalid:${now.toISOString().slice(0, 10)}` },
    },
  ]);
}

/**
 * Brings one message's media home and, for a voice note, transcribes it. Idempotent end to end, so the queue can retry
 * freely: the file is written only when `media_path` is still empty, the transcript only while status is still `pending`
 * and the message has not been deleted by the customer in the meantime.
 *
 * Failure policy (Meta keeps media ~30 days and its download URLs for minutes):
 *   - gone / unacceptable file (MIME not allowed, too large, kind mismatch) -> terminal "unavailable", job succeeds;
 *   - bad token -> critical alert, job fails (the owner must fix the token; the failed job stays visible);
 *   - network / rate limit / 5xx / hash mismatch -> the job fails and the queue retries with backoff;
 *   - transcription failing on the last attempt -> status `failed`, the file is kept, the owner can listen.
 */
export async function downloadMediaForMessage(messageId: string, options: MediaJobOptions): Promise<MediaOutcome> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const root = options.root ?? getEnv().MEDIA_STORAGE_DIR;

  const [row] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!row) {
    logger.warn({ messageId }, 'media job for a message that does not exist');
    return 'message_missing';
  }
  // A message the customer deleted never gets its media fetched; a non-media message has nothing to fetch.
  if (row.deletedAt !== null) return 'no_media';
  const type = row.type;
  if (!isKind(type)) return 'no_media';
  const kind = type;
  // No file and no reference to one: it was settled as unavailable earlier (or never had media).
  if (row.mediaPath === null && row.mediaId === null) return 'no_media';

  let bytes: Uint8Array | null = null;
  let stored = false;

  if (row.mediaPath === null) {
    if (row.mediaId === null) return 'no_media';
    try {
      const info = await getMediaInfo(row.mediaId);
      const mime = checkMime(info.mimeType ?? row.mediaMime, kind);
      if (!mime.ok) {
        await markUnavailable(db, row, kind, mime.reason);
        return 'unavailable';
      }
      if (info.fileSize !== null && info.fileSize > maxBytesFor(kind)) {
        await markUnavailable(db, row, kind, 'too_large');
        return 'unavailable';
      }
      const downloaded = await downloadMedia(info.url, maxBytesFor(kind));
      if (verifySha256(downloaded.bytes, info.sha256) === 'mismatch') {
        // Truncated or substituted: never keep it. Retry; on the last attempt give up visibly.
        if (!options.finalAttempt) throw new GraphError('downloaded bytes do not match the hash Meta reported', 'retryable');
        await markUnavailable(db, row, kind, 'sha256_mismatch');
        return 'unavailable';
      }
      const relative = mediaRelativePath(now, row.id, mime.extension);
      await saveAtomically(resolveMediaPath(root, relative), downloaded.bytes);
      const updated = await db
        .update(messages)
        .set({ mediaPath: relative, mediaMime: mime.mime })
        .where(and(eq(messages.id, row.id), isNull(messages.mediaPath)))
        .returning({ id: messages.id });
      stored = updated.length > 0;
      bytes = downloaded.bytes;
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      if (error.failure === 'gone' || error.failure === 'permanent') {
        await markUnavailable(db, row, kind, `graph_${error.failure}`);
        return 'unavailable';
      }
      if (error.failure === 'auth') await alertBadToken(now);
      throw error;
    }
  }

  if (kind === 'audio' && row.transcriptionStatus === 'pending') {
    if (bytes === null && row.mediaPath !== null) bytes = new Uint8Array(await readFile(resolveMediaPath(root, row.mediaPath)));
    if (bytes !== null) await transcribeAndStore(db, row, bytes, options.finalAttempt);
  }

  if (stored) {
    await runEffects([{ type: 'publish', event: { type: 'conversation:updated', payload: { conversationId: row.conversationId } } }]);
  }
  return stored ? 'stored' : 'already_stored';
}

async function transcribeAndStore(db: Db, row: MessageRow, bytes: Uint8Array, finalAttempt: boolean): Promise<void> {
  try {
    const result = await transcribeVoiceNote(bytes, { db });
    const content = transcriptContent(result.assessment, result.text);
    const done = result.assessment.status === 'done';
    const updated = await db
      .update(messages)
      .set({ content, contentSource: done ? 'transcript' : 'rendered', transcriptionStatus: result.assessment.status })
      // Only while pending, and never resurrect text the customer deleted for everyone in the meantime.
      .where(and(eq(messages.id, row.id), eq(messages.transcriptionStatus, 'pending'), isNull(messages.deletedAt)))
      .returning({ id: messages.id });
    if (result.assessment.status === 'low_confidence') {
      logger.info({ messageId: row.id, reasons: result.assessment.reasons }, 'voice note transcript judged unreliable');
    }
    if (updated.length > 0) {
      await runEffects([{ type: 'publish', event: { type: 'conversation:updated', payload: { conversationId: row.conversationId } } }]);
    }
  } catch (error) {
    if (!(error instanceof AiProviderError)) throw error;
    if (error.retryable && !finalAttempt) throw error;
    await db
      .update(messages)
      .set({ transcriptionStatus: 'failed' })
      .where(and(eq(messages.id, row.id), eq(messages.transcriptionStatus, 'pending')));
    logger.warn({ messageId: row.id, status: error.status }, 'voice note could not be transcribed');
  }
}
