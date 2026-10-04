import { vi } from 'vitest';

export interface CapturedRequest {
  url: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
  formFields: Record<string, string> | null;
}

export type GroqHandler = (request: CapturedRequest, index: number) => Response | Promise<Response>;

/** A chat completion exactly as Groq's OpenAI-compatible endpoint returns it. */
export function chatCompletion(content: string, usage: { prompt?: number; completion?: number } = {}): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1_790_000_000,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: usage.prompt ?? 21, completion_tokens: usage.completion ?? 8, total_tokens: (usage.prompt ?? 21) + (usage.completion ?? 8) },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export interface SegmentStats {
  avgLogprob?: number;
  compressionRatio?: number;
  noSpeechProb?: number;
}

/**
 * A verbose_json transcription response with every field Groq really sends (the AI SDK validates the full shape, so a
 * thinner stub would be rejected). Groq reports the language by NAME ("english"), Whisper-style. The per-segment stats
 * default to a confident, clean recording.
 */
export function transcription(text: string, language: string, durationSeconds: number, stats: SegmentStats = {}): Response {
  return new Response(
    JSON.stringify({
      task: 'transcribe',
      language,
      duration: durationSeconds,
      text,
      x_groq: { id: 'req_test' },
      segments: [
        {
          id: 0,
          seek: 0,
          start: 0,
          end: durationSeconds,
          text,
          tokens: [50364, 2425],
          temperature: 0,
          avg_logprob: stats.avgLogprob ?? -0.21,
          compression_ratio: stats.compressionRatio ?? 1.3,
          no_speech_prob: stats.noSpeechProb ?? 0.01,
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export const apiError = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), { status, headers: { 'content-type': 'application/json' } });

/**
 * Replaces global fetch for the Groq API (mock at the network layer, per the testing rules). Every request is captured; the
 * handler decides the answer. Anything not aimed at Groq is a test bug and fails loudly rather than reaching the network.
 */
export function stubGroq(handler: GroqHandler): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://api.groq.com/')) throw new Error(`unexpected network call in test: ${url}`);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));

      let body: Record<string, unknown> | null = null;
      let formFields: Record<string, string> | null = null;
      if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
      else if (init?.body instanceof FormData) {
        formFields = {};
        for (const [key, value] of init.body.entries()) formFields[key] = typeof value === 'string' ? value : `[file ${value.size} bytes]`;
      }
      const captured: CapturedRequest = { url, path: new URL(url).pathname, body, headers, formFields };
      requests.push(captured);

      // A real network call can be aborted; honour the caller's signal so timeouts behave as they would in production.
      const signal = init?.signal;
      const answer = Promise.resolve(handler(captured, requests.length - 1));
      if (!signal) return answer;
      return Promise.race([
        answer,
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    }),
  );
  return { requests };
}
