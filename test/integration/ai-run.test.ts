import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiOutputError, AiProviderError } from '@/lib/ai/errors';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache, runStructured } from '@/lib/ai/run';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';
import { apiError, chatCompletion, stubGroq } from '../helpers/groq';

let admin: Sql;

beforeAll(() => {
  admin = migratorSql();
});

beforeEach(async () => {
  await resetDb(admin);
  resetStrictCache();
  resetModelProvider();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await closeAllDb();
});

const schema = z.object({ intent: z.enum(['question', 'order']), reply: z.string().min(1), missing: z.array(z.string()) });
const valid = JSON.stringify({ intent: 'question', reply: 'Yes, we are open.', missing: [] });
const base = { purpose: 'draft' as const, modelId: 'test-draft-model', promptVersion: 'draft-v1', schema, instructions: 'You are a careful assistant. Reply in JSON.', prompt: 'Are you open today?' };

const runs = () => admin<Array<{ purpose: string; model: string; prompt_version: string | null; input_tokens: number; output_tokens: number; ok: boolean; error: string | null; latency_ms: number }>>`SELECT * FROM ai_runs ORDER BY created_at, id`;

describe('runStructured', () => {
  it('returns the validated object, sends the instructions as the system message, and records one ai_runs row', async () => {
    const { requests } = stubGroq(() => chatCompletion(valid, { prompt: 120, completion: 33 }));
    const result = await runStructured(base);

    expect(result.output).toEqual({ intent: 'question', reply: 'Yes, we are open.', missing: [] });
    expect(result).toMatchObject({ inputTokens: 120, outputTokens: 33, attempts: 1 });

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as { model: string; messages: Array<{ role: string; content: string }>; response_format?: { type: string; json_schema?: { strict?: boolean } } };
    expect(requests[0]?.path).toBe('/openai/v1/chat/completions');
    expect(body.model).toBe('test-draft-model');
    expect(body.messages[0]).toEqual({ role: 'system', content: base.instructions });
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: base.prompt });
    expect(body.response_format?.type).toBe('json_schema');
    expect(body.response_format?.json_schema?.strict).toBe(true);
    expect(requests[0]?.headers.authorization).toBe('Bearer test-groq-key');

    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'draft', model: 'test-draft-model', prompt_version: 'draft-v1', input_tokens: 120, output_tokens: 33, ok: true, error: null });
  });

  it('makes ONE corrective retry when the answer does not match the schema, naming the broken field but never its value', async () => {
    const bad = JSON.stringify({ intent: 'gossip', reply: 'SECRET-CUSTOMER-TEXT-IN-A-BAD-ANSWER', missing: [] });
    const { requests } = stubGroq((_request, index) => chatCompletion(index === 0 ? bad : valid));
    const result = await runStructured(base);

    expect(result.attempts).toBe(2);
    expect(result.output.intent).toBe('question');
    const second = requests[1]?.body as { messages: Array<{ role: string; content: string }> };
    const corrective = second.messages.at(-1)?.content ?? '';
    expect(corrective).toContain('did not match the required JSON schema');
    expect(corrective).toContain('intent');
    expect(corrective).not.toContain('SECRET-CUSTOMER-TEXT');
    expect(corrective.startsWith(base.prompt)).toBe(true);

    const rows = await runs();
    expect(rows.map((row) => row.ok)).toEqual([false, true]);
    expect(rows[0]?.error).toContain('invalid_output');
    expect(JSON.stringify(rows)).not.toContain('SECRET-CUSTOMER-TEXT');
  });

  it('gives up with AiOutputError after the corrective retry, naming the fields and not the values', async () => {
    const bad = JSON.stringify({ intent: 'question', reply: '', missing: 'not-an-array', extra: 'SECRET' });
    stubGroq(() => chatCompletion(bad));
    const error = await runStructured(base).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiOutputError);
    expect((error as AiOutputError).issues).toEqual(expect.arrayContaining(['missing']));
    expect(String(error)).not.toContain('SECRET');
    const rows = await runs();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.ok)).toBe(true);
  });

  it('survives text that is not JSON at all', async () => {
    stubGroq(() => chatCompletion('Sure! Here is the reply you asked for.'));
    await expect(runStructured(base)).rejects.toBeInstanceOf(AiOutputError);
  });

  it('falls back to non-strict JSON-schema mode once when the model rejects strict decoding, and remembers it', async () => {
    const { requests } = stubGroq((request) => {
      const strict = (request.body?.response_format as { json_schema?: { strict?: boolean } } | undefined)?.json_schema?.strict;
      return strict ? apiError(400, 'This model does not support strict json_schema constrained decoding') : chatCompletion(valid);
    });

    const first = await runStructured(base);
    expect(first.output.intent).toBe('question');
    expect(requests).toHaveLength(2);
    expect((requests[1]?.body?.response_format as { json_schema: { strict: boolean } }).json_schema.strict).toBe(false);

    await runStructured(base);
    expect(requests).toHaveLength(3); // the second call went straight to non-strict
    expect((requests[2]?.body?.response_format as { json_schema: { strict: boolean } }).json_schema.strict).toBe(false);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [401, false],
    [403, false],
    [400, false],
  ])('maps provider HTTP %s to a typed error (retryable=%s) without ever retrying the queue’s job inside the call', async (status, retryable) => {
    stubGroq(() => apiError(status, status === 400 ? 'Bad request' : 'upstream trouble'));
    const error = await runStructured(base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ retryable, status });
    const rows = await runs();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((row) => !row.ok && (row.error ?? '').startsWith('APICallError'))).toBe(true);
  });

  it('enforces the per-call timeout and reports it as retryable', async () => {
    stubGroq(() => new Promise<Response>(() => undefined)); // never answers
    const started = Date.now();
    const error = await runStructured({ ...base, timeoutMs: 150 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await runs())[0]?.ok).toBe(false);
  });

  it('never lets a failure to write ai_runs break the call', async () => {
    stubGroq(() => chatCompletion(valid));
    const broken = { insert: () => { throw new Error('database is down'); } } as unknown as Parameters<typeof runStructured>[0]['db'];
    const result = await runStructured({ ...base, db: broken });
    expect(result.output.intent).toBe('question');
  });

  it('passes temperature, token limit and reasoning effort through', async () => {
    const { requests } = stubGroq(() => chatCompletion(valid));
    await runStructured({ ...base, temperature: 0.2, maxOutputTokens: 400, reasoning: 'low' });
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(400);
    expect(JSON.stringify(body)).toContain('low');
  });
});
