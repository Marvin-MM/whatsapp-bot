import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': `${root}src`,
      // `server-only` throws outside Next's bundler; tests run in plain Node.
      'server-only': `${root}test/stubs/server-only.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['test/setup/env.ts'],
  },
});
