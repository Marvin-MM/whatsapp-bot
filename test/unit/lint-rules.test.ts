import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// These tests lock in the architectural rules from the spec: they fail if someone loosens eslint.config.mjs.
let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
});

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).flatMap((message) => (message.ruleId ? [message.ruleId] : []));
}

describe('framework-free restriction (src/lib and worker)', () => {
  it('rejects next/* imports in src/lib', async () => {
    expect(await ruleIds("import { headers } from 'next/headers';\nexport const h = headers;\n", 'src/lib/example.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('rejects react imports in src/lib', async () => {
    expect(await ruleIds("import { useState } from 'react';\nexport const s = useState;\n", 'src/lib/example.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('rejects next and react imports in worker/', async () => {
    expect(await ruleIds("import { NextResponse } from 'next/server';\nexport const r = NextResponse;\n", 'worker/example.ts')).toContain(
      'no-restricted-imports',
    );
    expect(await ruleIds("import { useState } from 'react';\nexport const s = useState;\n", 'worker/example.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('allows next and react outside src/lib and worker', async () => {
    expect(await ruleIds("import { headers } from 'next/headers';\nexport const h = headers;\n", 'src/actions/example.ts')).not.toContain(
      'no-restricted-imports',
    );
  });
});

describe('process.env restriction', () => {
  const code = 'export const value = process.env.SOMETHING;\n';

  it('rejects process.env outside env.ts', async () => {
    expect(await ruleIds(code, 'src/lib/other.ts')).toContain('no-restricted-properties');
    expect(await ruleIds(code, 'worker/example.ts')).toContain('no-restricted-properties');
    expect(await ruleIds(code, 'src/app/example.ts')).toContain('no-restricted-properties');
  });

  it('allows process.env in env.ts and test bootstrap', async () => {
    expect(await ruleIds(code, 'src/lib/env.ts')).not.toContain('no-restricted-properties');
    expect(await ruleIds(code, 'test/setup/example.ts')).not.toContain('no-restricted-properties');
  });
});

describe('type safety rules', () => {
  it('rejects explicit any', async () => {
    expect(await ruleIds('export const value: any = 1;\n', 'src/lib/example.ts')).toContain('@typescript-eslint/no-explicit-any');
  });

  it('rejects non-null assertions', async () => {
    expect(await ruleIds('export const read = (v: { a?: string }) => v.a!.length;\n', 'src/lib/example.ts')).toContain(
      '@typescript-eslint/no-non-null-assertion',
    );
  });
});
