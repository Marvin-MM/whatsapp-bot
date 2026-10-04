import 'server-only';
import { createGroq } from '@ai-sdk/groq';
import { getEnv } from '@/lib/env';

/**
 * The one place a model is created. Model ids come ONLY from the environment (LLM_MODEL_*): changing a model is an
 * environment change plus an eval run, never a code change. `fetch` is looked up at call time so tests can stub the
 * network layer, and the provider itself is built lazily so importing this file never forces env validation.
 */
let provider: ReturnType<typeof createGroq> | undefined;

function groq(): ReturnType<typeof createGroq> {
  provider ??= createGroq({
    apiKey: getEnv().GROQ_API_KEY,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  return provider;
}

export type ChatPurpose = 'draft' | 'analysis' | 'verify';

export function chatModelId(purpose: ChatPurpose): string {
  const env = getEnv();
  switch (purpose) {
    case 'draft':
      return env.LLM_MODEL_DRAFT;
    case 'analysis':
      return env.LLM_MODEL_ANALYSIS;
    case 'verify':
      return env.LLM_MODEL_VERIFY;
  }
}

export function chatModel(modelId: string) {
  return groq()(modelId);
}

export const transcriptionModelId = (): string => getEnv().LLM_MODEL_TRANSCRIBE;

export function transcriptionModel() {
  return groq().transcription(transcriptionModelId());
}

/** For tests that change the environment between cases. */
export function resetModelProvider(): void {
  provider = undefined;
}
