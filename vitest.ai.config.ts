import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * `pnpm test:ai`: the opt-in suite that talks to the REAL model (spec 13, Phase 4). It costs a few cents and sends invented customer text
 * to Groq, so nothing runs it by accident (not CI, not `pnpm test`).
 *
 * It needs the real key and model ids. They are read from the environment, or from `.env`, but ONLY these names: `.env` also holds
 * DATABASE_URL and friends, and this suite runs against the throwaway `_test` database like the integration tests do.
 */
const FROM_DOTENV = ['GROQ_API_KEY', 'LLM_MODEL_DRAFT'] as const;
if (existsSync(`${root}.env`)) {
  const parsed = parseEnv(readFileSync(`${root}.env`, 'utf8'));
  for (const name of FROM_DOTENV) if (!process.env[name] && parsed[name]) process.env[name] = parsed[name];
}
for (const name of FROM_DOTENV) {
  if (!process.env[name]) throw new Error(`pnpm test:ai needs ${name} (in the environment or in .env): it talks to the real model. See README, "Testing against the real model".`);
}
process.env.AI_TESTS = '1';

export default defineConfig({
  resolve: {
    alias: {
      '@': `${root}src`,
      'server-only': `${root}test/stubs/server-only.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['test/ai/**/*.test.ts'],
    setupFiles: ['test/setup/env.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
