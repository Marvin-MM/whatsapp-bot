import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Integration tests hit a real Postgres + Redis (docker compose or native).
// Files run sequentially against one migrated database; tests truncate between cases.
export default defineConfig({
  resolve: {
    alias: {
      '@': `${root}src`,
      'server-only': `${root}test/stubs/server-only.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['test/setup/env.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
