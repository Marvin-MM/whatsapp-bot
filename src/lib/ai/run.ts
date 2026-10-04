import 'server-only';
import type { GroqLanguageModelChatOptions } from '@ai-sdk/groq';
import {
  APICallError,
  JSONParseError,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  TypeValidationError,
  generateText,
} from 'ai';
import { ZodError, type z } from 'zod';
import { type Db, getDb } from '@/lib/db';
import { type aiPurpose, aiRuns } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { AiOutputError, AiProviderError } from './errors';
import { chatModel } from './models';

export type AiPurpose = (typeof aiPurpose.enumValues)[number];

export interface RunStructuredOptions<S extends z.ZodType> {
  purpose: AiPurpose;
  /** From env via `chatModelId(...)`; never a literal in code. */
  modelId: string;
  promptVersion?: string;
  schema: S;
  /** Standing instructions (the v7 `instructions` parameter, not `system`). */
  instructions: string;
  /** Everything that varies per call. Customer text in here is DATA and must already be sanitised by the caller. */
  prompt: string;
  draftId?: string;
  /** Per model call (spec 9.1). Default 30 000. */
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /** Injected for tests; defaults to the shared client. */
  db?: Db;
}

export interface RunStructuredResult<T> {
  output: T;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Model calls made (2 when the first answer was invalid and the corrective retry was needed). */
  attempts: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Models whose Groq structured-output mode rejected strict JSON-schema decoding (HTTP 400). Strict decoding is only
 * available on some models; once a model refuses it we stop asking for the rest of the process's life instead of paying
 * a failed round trip on every call.
 */
const strictRejected = new Set<string>();

const STRICT_REJECTION = /json[_ ]?schema|strict|response_format|constrained/i;

type Failure =
  | { kind: 'strict_rejected' }
  | { kind: 'invalid_output'; issues: string[] }
  | { kind: 'provider'; retryable: boolean; status: number | null; label: string };

function issuePaths(error: unknown, depth = 0): string[] {
  if (depth > 5 || typeof error !== 'object' || error === null) return [];
  if (error instanceof ZodError) return error.issues.map((issue) => issue.path.join('.') || '(root)');
  return issuePaths((error as { cause?: unknown }).cause, depth + 1);
}

function classify(error: unknown, strict: boolean): Failure {
  const inner = RetryError.isInstance(error) ? ((error as { lastError?: unknown }).lastError ?? error) : error;

  if (APICallError.isInstance(inner)) {
    if (inner.statusCode === 400 && strict && STRICT_REJECTION.test(inner.message)) return { kind: 'strict_rejected' };
    const retryable = inner.isRetryable || inner.statusCode === 429 || (inner.statusCode ?? 0) >= 500;
    return { kind: 'provider', retryable, status: inner.statusCode ?? null, label: `APICallError${inner.statusCode ? ` ${inner.statusCode}` : ''}` };
  }
  if (
    NoObjectGeneratedError.isInstance(inner) ||
    TypeValidationError.isInstance(inner) ||
    JSONParseError.isInstance(inner) ||
    NoOutputGeneratedError.isInstance(inner) ||
    NoContentGeneratedError.isInstance(inner) ||
    inner instanceof AiOutputError
  ) {
    return { kind: 'invalid_output', issues: inner instanceof AiOutputError ? [...inner.issues] : issuePaths(inner) };
  }
  const name = inner instanceof Error ? inner.name : 'unknown';
  return { kind: 'provider', retryable: true, status: null, label: name };
}

async function recordRun(
  db: Db,
  row: { purpose: AiPurpose; model: string; promptVersion?: string; inputTokens: number; outputTokens: number; latencyMs: number; ok: boolean; error?: string; draftId?: string },
): Promise<void> {
  try {
    await db.insert(aiRuns).values({
      purpose: row.purpose,
      model: row.model,
      promptVersion: row.promptVersion ?? null,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      latencyMs: row.latencyMs,
      ok: row.ok,
      error: row.error ?? null,
      draftId: row.draftId ?? null,
    });
  } catch (error) {
    // Bookkeeping must never fail the work it describes.
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'could not record ai run');
  }
}

/**
 * Every structured model call in the system goes through here (spec 9.1): `generateText` + `Output.object` (never
 * `generateObject`), a per-call timeout, an `ai_runs` row per call (tokens, latency, ok, a content-free error), Zod
 * validation, ONE corrective retry when the answer does not match the schema, and a typed failure otherwise.
 *
 *   - invalid output  -> one retry that names the broken fields (never the value) -> `AiOutputError`;
 *   - strict-schema rejection (HTTP 400 from a model without constrained decoding) -> once, without strict mode;
 *   - transient provider failure (timeout, 429, 5xx, network) -> `AiProviderError(retryable)`: the queue's attempts and
 *     backoff own the retrying, so a stuck provider cannot hold a worker for minutes inside one job.
 *
 * What the model returned is never logged or stored here: it can contain customer text.
 */
export async function runStructured<S extends z.ZodType>(options: RunStructuredOptions<S>): Promise<RunStructuredResult<z.infer<S>>> {
  const db = options.db ?? getDb();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let strict = !strictRejected.has(options.modelId);
  let corrected = false;
  let prompt = options.prompt;
  let attempts = 0;

  for (;;) {
    const started = performance.now();
    attempts += 1;
    try {
      const result = await generateText({
        model: chatModel(options.modelId),
        instructions: options.instructions,
        prompt,
        output: Output.object({ schema: options.schema }),
        timeout: timeoutMs,
        maxRetries: 1,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        providerOptions: { groq: { strictJsonSchema: strict } satisfies GroqLanguageModelChatOptions },
      });
      const parsed = options.schema.safeParse(result.output);
      if (!parsed.success) throw new AiOutputError(options.purpose, parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'));

      const latencyMs = Math.round(performance.now() - started);
      const inputTokens = result.totalUsage.inputTokens ?? 0;
      const outputTokens = result.totalUsage.outputTokens ?? 0;
      await recordRun(db, { purpose: options.purpose, model: options.modelId, ...(options.promptVersion ? { promptVersion: options.promptVersion } : {}), inputTokens, outputTokens, latencyMs, ok: true, ...(options.draftId ? { draftId: options.draftId } : {}) });
      return { output: parsed.data, inputTokens, outputTokens, latencyMs, attempts };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const failure = classify(error, strict);
      const label = failure.kind === 'provider' ? failure.label : failure.kind === 'invalid_output' ? `invalid_output: ${failure.issues.join(', ')}`.slice(0, 200) : 'strict_schema_rejected';
      await recordRun(db, { purpose: options.purpose, model: options.modelId, ...(options.promptVersion ? { promptVersion: options.promptVersion } : {}), inputTokens: 0, outputTokens: 0, latencyMs, ok: false, error: label, ...(options.draftId ? { draftId: options.draftId } : {}) });

      if (failure.kind === 'strict_rejected') {
        strictRejected.add(options.modelId);
        strict = false;
        continue;
      }
      if (failure.kind === 'invalid_output') {
        if (corrected) throw new AiOutputError(options.purpose, failure.issues);
        corrected = true;
        const where = failure.issues.length > 0 ? ` The problems were in: ${failure.issues.join(', ')}.` : '';
        prompt = `${options.prompt}\n\nYour previous reply did not match the required JSON schema.${where} Reply again with ONLY a JSON object that matches the schema exactly.`;
        continue;
      }
      logger.warn({ purpose: options.purpose, model: options.modelId, status: failure.status, label: failure.label }, 'ai call failed');
      throw new AiProviderError(`${options.purpose} model call failed (${failure.label})`, failure.retryable, failure.status);
    }
  }
}

/** For tests: forget which models rejected strict mode. */
export function resetStrictCache(): void {
  strictRejected.clear();
}
