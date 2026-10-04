import 'server-only';
import type { GroqTranscriptionModelOptions } from '@ai-sdk/groq';
import { APICallError, NoTranscriptGeneratedError, RetryError, transcribe } from 'ai';
import { z } from 'zod';
import { type Db, getDb } from '@/lib/db';
import { aiRuns } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { AiProviderError } from './errors';
import { transcriptionModel, transcriptionModelId } from './models';

/**
 * Voice-note transcription. The owner's customers speak English, Luganda and a mix; Whisper has NO Luganda and, given speech
 * it does not know, produces fluent-looking nonsense (often labelled Swahili or English, sometimes a repeated phrase). So a
 * transcript is only ever trusted when it looks like plausible English; anything else is marked `low_confidence` and its text
 * is DISCARDED: it is never stored, shown to a model, or used to draft a reply. The owner listens to the audio instead.
 */

/** Whisper's own per-segment confidence signals, aggregated over a recording. Any of them may be absent. */
export interface SegmentStats {
  /** Duration-weighted mean of the segments' average log-probability (closer to 0 is more confident). */
  avgLogprob?: number | undefined;
  /** The worst (highest) compression ratio: a high one means repeated, hallucinated text. */
  maxCompressionRatio?: number | undefined;
  /** The highest probability that a segment is silence rather than speech. */
  maxNoSpeechProb?: number | undefined;
}

export interface TranscriptFacts {
  text: string;
  /** The language as detected by the model, when it says ("en", or "english": Groq reports a name). */
  language: string | undefined;
  durationInSeconds: number | undefined;
  stats?: SegmentStats | undefined;
}

/** Whisper's own decoding thresholds (its reference implementation uses exactly these to decide a segment failed). */
const MIN_AVG_LOGPROB = -1.0;
const MAX_COMPRESSION_RATIO = 2.4;
const MAX_NO_SPEECH_PROB = 0.6;

const rawBodySchema = z.looseObject({
  segments: z
    .array(
      z.looseObject({
        start: z.number().optional(),
        end: z.number().optional(),
        avg_logprob: z.number().optional(),
        compression_ratio: z.number().optional(),
        no_speech_prob: z.number().optional(),
      }),
    )
    .optional(),
});

/**
 * The provider's raw response body. The SDK returns it at runtime in `responses[0].body` but does not declare it in the
 * type, so it is read defensively: if a future SDK stops passing it, we simply lose the extra signals and keep the text
 * heuristics (an integration test fails first, so this cannot degrade silently).
 */
function rawBodyOf(response: unknown): unknown {
  return typeof response === 'object' && response !== null ? (response as { body?: unknown }).body : undefined;
}

/** Reads the per-segment stats out of the provider's raw response body (the SDK does not surface them). Never throws. */
export function segmentStatsOf(rawBody: unknown): SegmentStats {
  const parsed = rawBodySchema.safeParse(rawBody);
  const segments = parsed.success ? (parsed.data.segments ?? []) : [];
  let weighted = 0;
  let weight = 0;
  let maxCompression: number | undefined;
  let maxNoSpeech: number | undefined;
  for (const segment of segments) {
    if (segment.avg_logprob !== undefined) {
      const span = segment.start !== undefined && segment.end !== undefined && segment.end > segment.start ? segment.end - segment.start : 1;
      weighted += segment.avg_logprob * span;
      weight += span;
    }
    if (segment.compression_ratio !== undefined) maxCompression = Math.max(maxCompression ?? 0, segment.compression_ratio);
    if (segment.no_speech_prob !== undefined) maxNoSpeech = Math.max(maxNoSpeech ?? 0, segment.no_speech_prob);
  }
  return { avgLogprob: weight > 0 ? weighted / weight : undefined, maxCompressionRatio: maxCompression, maxNoSpeechProb: maxNoSpeech };
}

export type TranscriptAssessment = { status: 'done' } | { status: 'low_confidence'; reasons: string[] };

const WORDS = /[\p{L}\p{N}']+/gu;

/**
 * The most times any phrase of 1-8 words is repeated back to back: the classic hallucination loop is a phrase, not a single
 * word ("thank you thank you thank you ..."), so single-word runs alone would miss it.
 */
function maxPhraseRepeats(words: readonly string[]): number {
  let best = words.length === 0 ? 0 : 1;
  for (let size = 1; size <= 8; size += 1) {
    for (let start = 0; start + 2 * size <= words.length; start += 1) {
      let repeats = 1;
      while (start + (repeats + 1) * size <= words.length) {
        const same = words.slice(start, start + size).every((word, i) => word === words[start + repeats * size + i]);
        if (!same) break;
        repeats += 1;
      }
      best = Math.max(best, repeats);
    }
  }
  return best;
}

/**
 * Pure and deterministic. Reasons (never text) are logged so a bad batch of transcripts can be diagnosed without exposing
 * what anyone said. Thresholds are deliberately conservative: a false "low confidence" costs the owner one listen; a false
 * "done" feeds the model a fiction.
 */
export function assessTranscript(facts: TranscriptFacts): TranscriptAssessment {
  const reasons: string[] = [];
  const text = facts.text.trim();
  const words = (text.toLowerCase().match(WORDS) ?? []).filter((word) => word.length > 0);

  if (words.length === 0) reasons.push('no_speech');
  const language = facts.language?.toLowerCase();
  if (language === undefined || language === '') reasons.push('language_unknown');
  else if (language !== 'en' && language !== 'english') reasons.push('language_not_english');

  if (words.length >= 4) {
    if (maxPhraseRepeats(words) >= 4) reasons.push('repetition_loop');
    const distinct = new Set(words).size;
    if (words.length >= 12 && distinct / words.length < 0.3) reasons.push('low_vocabulary_variety');
  }
  if (facts.durationInSeconds !== undefined && facts.durationInSeconds >= 3 && words.length > 0) {
    const rate = words.length / facts.durationInSeconds;
    if (rate < 0.3 || rate > 6) reasons.push('implausible_speech_rate');
  }
  const stats = facts.stats;
  if (stats?.avgLogprob !== undefined && stats.avgLogprob < MIN_AVG_LOGPROB) reasons.push('low_model_confidence');
  if (stats?.maxCompressionRatio !== undefined && stats.maxCompressionRatio > MAX_COMPRESSION_RATIO) reasons.push('repetitive_text');
  if (stats?.maxNoSpeechProb !== undefined && stats.maxNoSpeechProb > MAX_NO_SPEECH_PROB) reasons.push('probably_not_speech');
  return reasons.length === 0 ? { status: 'done' } : { status: 'low_confidence', reasons };
}

export const TRANSCRIPT_LABEL = '[Voice message, auto-transcribed]';
export const UNRELIABLE_LABEL = '[Voice message: automatic transcript unreliable, please listen]';
const MAX_TRANSCRIPT_CHARS = 4000;

/** The text stored in `messages.content`: always labelled as machine-made; unreliable transcripts carry no text at all. */
export function transcriptContent(assessment: TranscriptAssessment, text: string): string {
  return assessment.status === 'done' ? `${TRANSCRIPT_LABEL} ${text.trim().slice(0, MAX_TRANSCRIPT_CHARS)}` : UNRELIABLE_LABEL;
}

export interface TranscribeResult {
  assessment: TranscriptAssessment;
  /** The raw transcript; callers must use `transcriptContent`, which drops it when unreliable. */
  text: string;
  language: string | undefined;
  durationInSeconds: number | undefined;
  latencyMs: number;
}

const TRANSCRIBE_TIMEOUT_MS = 60_000;

async function recordRun(db: Db, ok: boolean, latencyMs: number, error?: string): Promise<void> {
  try {
    await db.insert(aiRuns).values({
      purpose: 'transcribe',
      model: transcriptionModelId(),
      promptVersion: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs,
      ok,
      error: error ?? null,
      draftId: null,
    });
  } catch (cause) {
    logger.warn({ error: cause instanceof Error ? cause.name : 'unknown' }, 'could not record ai run');
  }
}

/** Sends one voice note to the transcription model. Throws `AiProviderError` (retryable or not); never logs the content. */
export async function transcribeVoiceNote(bytes: Uint8Array, options: { db?: Db } = {}): Promise<TranscribeResult> {
  const db = options.db ?? getDb();
  const started = performance.now();
  try {
    const result = await transcribe({
      model: transcriptionModel(),
      audio: bytes,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      providerOptions: { groq: { responseFormat: 'verbose_json', timestampGranularities: ['segment'] } satisfies GroqTranscriptionModelOptions },
    });
    const latencyMs = Math.round(performance.now() - started);
    await recordRun(db, true, latencyMs);
    const facts = { text: result.text, language: result.language, durationInSeconds: result.durationInSeconds, stats: segmentStatsOf(rawBodyOf(result.responses[0])) };
    return { assessment: assessTranscript(facts), text: result.text, language: result.language, durationInSeconds: result.durationInSeconds, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const inner = RetryError.isInstance(error) ? ((error as { lastError?: unknown }).lastError ?? error) : error;
    if (APICallError.isInstance(inner)) {
      const retryable = inner.isRetryable || inner.statusCode === 429 || (inner.statusCode ?? 0) >= 500;
      await recordRun(db, false, latencyMs, `APICallError${inner.statusCode ? ` ${inner.statusCode}` : ''}`);
      throw new AiProviderError(`transcription failed (HTTP ${inner.statusCode ?? 'unknown'})`, retryable, inner.statusCode ?? null);
    }
    if (NoTranscriptGeneratedError.isInstance(inner)) {
      await recordRun(db, false, latencyMs, 'NoTranscriptGeneratedError');
      // The model returned nothing at all: same outcome as unusable speech, and not worth retrying.
      throw new AiProviderError('transcription returned no transcript', false);
    }
    const name = inner instanceof Error ? inner.name : 'unknown';
    await recordRun(db, false, latencyMs, name);
    throw new AiProviderError(`transcription failed (${name})`, true);
  }
}
