import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// worker/ and src/lib/ run in plain Node (worker) or are shared with it; they must stay framework-free.
const frameworkFree = {
  patterns: [
    {
      group: ['next', 'next/*', 'react', 'react/*', 'react-dom', 'react-dom/*'],
      message: 'worker/ and src/lib/ must not import next/* or react. Put framework code in src/app, src/actions or src/components.',
    },
  ],
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'node_modules/**', 'drizzle/**', 'data/**', 'eval/results/**', 'coverage/**', 'next-env.d.ts']),
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through src/lib/env.ts. It is the only file that may touch process.env.',
        },
      ],
    },
  },
  {
    files: ['src/lib/**/*.{ts,tsx}', 'worker/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', frameworkFree] },
  },
  {
    // env.ts owns process.env; tooling configs and test bootstrap necessarily set it.
    // instrumentation.ts must read NEXT_RUNTIME literally so the bundler can drop Node-only code from the Edge bundle.
    files: ['src/lib/env.ts', 'src/instrumentation.ts', '*.config.{ts,mjs}', 'test/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
]);
