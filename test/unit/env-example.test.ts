import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envSchema, parseEnv } from '@/lib/env';

/** `.env.example` is documentation users copy verbatim; it must never drift from the real schema. */
const text = readFileSync('.env.example', 'utf8');

function parse(): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    // Active (`KEY=value`) and commented-out (`# KEY=value`) assignments both document a variable.
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) values.set(match[1], match[2] ?? '');
  }
  return values;
}

describe('.env.example', () => {
  const documented = parse();

  it('documents exactly the variables the schema validates, no more and no fewer', () => {
    expect([...documented.keys()].sort()).toEqual(Object.keys(envSchema.shape).sort());
  });

  it('ships empty values for every secret so a copied file can never carry a credential', () => {
    const secrets = [
      'BETTER_AUTH_SECRET',
      'META_APP_SECRET',
      'WEBHOOK_VERIFY_TOKEN',
      'WHATSAPP_ACCESS_TOKEN',
      'GROQ_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
    ];
    for (const key of secrets) expect(documented.get(key), `${key} must be empty`).toBe('');
  });

  it('has defaults that pass validation once the blanks are filled in', () => {
    const filled: Record<string, string> = {};
    for (const [key, value] of documented) {
      if (key === 'NODE_ENV') continue;
      // A value in single quotes is the dotenv way to write JSON: the quotes are not part of the value.
      const unquoted = /^'(.*)'$/.exec(value)?.[1] ?? value;
      filled[key] = unquoted === '' ? 'x'.repeat(40) : unquoted;
    }
    filled.OWNER_EMAIL = 'owner@example.test';
    filled.META_GRAPH_VERSION = 'v25.0';
    const result = parseEnv(filled);
    expect(result.ok, result.ok ? '' : JSON.stringify(result.issues)).toBe(true);
  });

  it('points the app at the least-privilege role and the migrator at the migration role', () => {
    expect(documented.get('DATABASE_URL')).toContain('wab_app');
    expect(documented.get('DATABASE_MIGRATION_URL')).toContain('wab_migrator');
  });

  it('keeps the development passwords obviously dev-only', () => {
    expect(documented.get('DATABASE_URL')).toContain('_dev@');
    expect(documented.get('DATABASE_MIGRATION_URL')).toContain('_dev@');
  });
});
