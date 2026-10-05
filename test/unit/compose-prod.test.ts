import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envSchema } from '@/lib/env';

/**
 * Static guards for the production stack. They read the files, because nothing in CI can start Docker: they stop the quiet mistakes (a new
 * env variable that never reaches the containers, a secret leaking to the wrong service, a published database port) rather than prove the
 * stack runs (that is the deploy check in docs/operations/production.md).
 */
const compose = readFileSync('docker-compose.prod.yml', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');

function blockOf(text: string, header: RegExp): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return '';
  const indent = /^\s*/.exec(lines[start] ?? '')?.[0].length ?? 0;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && (/^\s*/.exec(line)?.[0].length ?? 0) <= indent) break;
    out.push(line);
  }
  return out.join('\n');
}

const appEnv = blockOf(compose, /^x-app-env:/);
const appEnvKeys = [...appEnv.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1] ?? '');
const service = (name: string) => blockOf(compose, new RegExp(`^ {2}${name}:`));

describe('docker-compose.prod.yml', () => {
  it('hands web and worker every variable the env schema knows (a new variable fails here until it is wired)', () => {
    expect(appEnvKeys.length).toBeGreaterThan(20);
    expect([...appEnvKeys].sort()).toEqual(Object.keys(envSchema.shape).sort());
  });

  it('passes variables explicitly: no env_file (it would hand every secret in .env to every container)', () => {
    expect(compose).not.toMatch(/^\s*env_file:/m);
  });

  it('keeps the migration role out of web and worker (they get the runtime role for the schema-required migration URL)', () => {
    expect(appEnv).not.toMatch(/wab_migrator|WAB_MIGRATOR_PASSWORD/);
    expect(appEnv).toMatch(/DATABASE_MIGRATION_URL: postgres:\/\/wab_app:/);
    expect(service('migrate')).toMatch(/wab_migrator:\$\{WAB_MIGRATOR_PASSWORD/);
  });

  it('runs web and worker only after the migration succeeded', () => {
    for (const name of ['web', 'worker']) expect(service(name)).toMatch(/migrate:\s*\n\s*condition: service_completed_successfully/);
  });

  it('publishes the database on loopback only, and only Caddy to the world', () => {
    expect(service('postgres')).toMatch(/"127\.0\.0\.1:5432:5432"/);
    expect(service('redis')).not.toMatch(/ports:/);
    expect(service('web')).not.toMatch(/ports:/);
    expect(service('worker')).not.toMatch(/ports:/);
  });

  it('protects Redis with a password and forbids eviction (BullMQ keys must never be dropped)', () => {
    const redis = service('redis');
    expect(redis).toContain('--requirepass');
    expect(redis).toContain('noeviction');
    expect(redis).toContain('--appendonly');
  });

  it('restarts the long-running services and not the one-shot migration', () => {
    for (const name of ['caddy', 'web', 'worker', 'postgres', 'redis']) expect(service(name)).toMatch(/restart: unless-stopped/);
    expect(service('migrate')).toMatch(/restart: "no"/);
  });

  it('mounts the media directory where the backup script expects it', () => {
    expect(service('web')).toContain('./data/media:/app/data/media');
    expect(service('worker')).toContain('./data/media:/app/data/media');
  });
});

describe('Dockerfile', () => {
  it('starts the app without pnpm (corepack would have to download it inside a locked-down container)', () => {
    const cmd = dockerfile.split('\n').find((line) => line.startsWith('CMD')) ?? '';
    expect(cmd).toContain('next');
    expect(cmd).not.toContain('pnpm');
  });

  it('runs as an unprivileged user', () => {
    expect(dockerfile).toMatch(/^USER app$/m);
  });
});

describe('Caddyfile', () => {
  const caddyfile = readFileSync('deploy/Caddyfile', 'utf8');

  it('overwrites X-Forwarded-For with the address it saw (login rate limiting depends on it)', () => {
    expect(caddyfile).toMatch(/header_up X-Forwarded-For \{remote_host\}/);
  });

  it('does not buffer or compress the event stream', () => {
    expect(caddyfile).toContain('flush_interval -1');
    expect(caddyfile).toMatch(/@compressible not path \/api\/events/);
  });
});
