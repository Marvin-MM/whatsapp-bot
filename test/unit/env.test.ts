import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { envSchema, parseEnv } from '@/lib/env';
import { TEST_ENV_DEFAULTS } from '../setup/env';

/** Vars with no schema default: omitting any of them must fail startup, naming it. */
const REQUIRED = [
  'APP_URL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'REDIS_URL',
  'OWNER_TIMEZONE',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'OWNER_EMAIL',
  'META_GRAPH_VERSION',
  'META_APP_SECRET',
  'WEBHOOK_VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_WABA_ID',
  'GROQ_API_KEY',
  'LLM_MODEL_DRAFT',
  'LLM_MODEL_ANALYSIS',
  'LLM_MODEL_VERIFY',
  'LLM_MODEL_TRANSCRIBE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
];

const WITH_DEFAULTS = [
  'NODE_ENV',
  'DATABASE_POOLER',
  'BULLMQ_PREFIX',
  'LOG_LEVEL',
  'TRANSCRIBE_AUDIO',
  'DRAFT_DEBOUNCE_SECONDS',
  'AUTOPILOT_MAX_EDIT_DISTANCE',
  'MEDIA_STORAGE_DIR',
];

function without(name: string): Record<string, string> {
  const copy: Record<string, string> = { ...TEST_ENV_DEFAULTS };
  delete copy[name];
  return copy;
}

describe('env schema', () => {
  it('classifies every schema key as required or defaulted (guards against forgetting new vars)', () => {
    const keys = Object.keys(envSchema.shape).sort();
    expect([...REQUIRED, ...WITH_DEFAULTS].sort()).toEqual(keys);
  });

  it('accepts the complete test environment', () => {
    const result = parseEnv(TEST_ENV_DEFAULTS);
    expect(result.ok).toBe(true);
  });

  it.each(REQUIRED)('rejects a missing %s and names it', (name) => {
    const result = parseEnv(without(name));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.name)).toContain(name);
  });

  it.each(WITH_DEFAULTS)('allows %s to be omitted', (name) => {
    expect(parseEnv(without(name)).ok).toBe(true);
  });

  it('treats an empty value (KEY=) as missing', () => {
    const result = parseEnv({ ...TEST_ENV_DEFAULTS, META_APP_SECRET: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.name)).toContain('META_APP_SECRET');
  });

  it('rejects malformed values', () => {
    const cases: Array<[string, string]> = [
      ['OWNER_TIMEZONE', 'Mars/Phobos'],
      ['META_GRAPH_VERSION', 'latest'],
      ['BETTER_AUTH_SECRET', 'too-short'],
      ['DATABASE_URL', 'mysql://localhost/db'],
      ['REDIS_URL', 'http://localhost:6379'],
      ['OWNER_EMAIL', 'not-an-email'],
      ['TRANSCRIBE_AUDIO', 'yes'],
      ['DRAFT_DEBOUNCE_SECONDS', '0'],
      ['AUTOPILOT_MAX_EDIT_DISTANCE', '1.5'],
    ];
    for (const [name, value] of cases) {
      const result = parseEnv({ ...TEST_ENV_DEFAULTS, [name]: value });
      expect(result.ok, `${name}=${value} should be rejected`).toBe(false);
      if (!result.ok) expect(result.issues.map((issue) => issue.name)).toContain(name);
    }
  });

  it('applies defaults and coerces types', () => {
    const result = parseEnv(without('DRAFT_DEBOUNCE_SECONDS'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.DRAFT_DEBOUNCE_SECONDS).toBe(25);
      expect(result.env.TRANSCRIBE_AUDIO).toBe(true);
      expect(result.env.AUTOPILOT_MAX_EDIT_DISTANCE).toBe(0.3);
    }
  });
});

describe('env startup (child process)', () => {
  function run(env: Record<string, string>) {
    return spawnSync('node_modules/.bin/tsx', ['--conditions=react-server', 'test/fixtures/env-probe.ts'], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      encoding: 'utf8',
      cwd: process.cwd(),
    });
  }

  it('starts with a complete environment', () => {
    const result = run(TEST_ENV_DEFAULTS);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('env ok');
  });

  it('exits 1 and names the missing variable', () => {
    const result = run(without('META_APP_SECRET'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('META_APP_SECRET');
  });
}, 60_000);
