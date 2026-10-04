import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkOwner } from '@/lib/auth-guard';
import { getDb } from '@/lib/db';
import { user as userTable } from '@/lib/db/auth-schema';
import { settings } from '@/lib/db/schema';
import { signInOwner } from '@/lib/owner';
import { secretFromOtpauthUri, totp } from '@/lib/totp';
import { headersWith, ownerEmail } from '../helpers/auth';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';

let admin: Sql;

beforeAll(() => {
  admin = migratorSql();
});

beforeEach(async () => {
  await resetDb(admin);
});

afterAll(async () => {
  await closeAllDb();
});

/** Runs the real script as a child process, the same way `pnpm seed:owner` does. */
function seed(args: string[], password: string) {
  return spawnSync('node_modules/.bin/tsx', ['--conditions=react-server', 'scripts/seed-owner.ts', ...args], {
    env: { ...process.env, NODE_ENV: 'test' },
    input: `${password}\n`,
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

describe('pnpm seed:owner', () => {
  const password = 'seeded-password-12345';

  it('creates the owner, seeds settings with the business name, enrolls TOTP, and the printed secret really works', async () => {
    const result = seed(['--name', 'Seed Owner', '--password-stdin', '--auto-verify'], password);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('otpauth://totp/');
    expect(result.stdout).toContain('Backup codes');
    expect(result.stdout).toContain('Owner ready');
    // The plaintext password must never be echoed.
    expect(result.stdout).not.toContain(password);
    expect(result.stderr).not.toContain(password);

    const [row] = await getDb().select().from(settings);
    expect(row).toMatchObject({ ownerName: 'Seed Owner', businessName: 'agent_47', autopilotPaused: true });
    const [account] = await getDb().select().from(userTable).where(eq(userTable.email, ownerEmail()));
    expect(account?.twoFactorEnabled).toBe(true);

    const uri = /URI:\s+(otpauth:\/\/\S+)/.exec(result.stdout)?.[1];
    expect(uri).toBeDefined();
    const secret = secretFromOtpauthUri(uri ?? '');
    const { cookie } = await signInOwner({ email: ownerEmail(), password, totpCode: totp(secret) });
    expect(await checkOwner(headersWith(cookie))).toMatchObject({ ok: true });
  });

  it('refuses to run a second time without --reset and leaves the owner untouched', async () => {
    expect(seed(['--name', 'Seed Owner', '--password-stdin', '--auto-verify'], password).status).toBe(0);
    const again = seed(['--name', 'Other Name', '--password-stdin', '--auto-verify'], 'another-password-9876');
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('--reset');
    const [row] = await getDb().select().from(settings);
    expect(row?.ownerName).toBe('Seed Owner');
  });

  it('--reset rotates the password and TOTP secret, and old credentials stop working', async () => {
    const first = seed(['--name', 'Seed Owner', '--password-stdin', '--auto-verify'], password);
    const oldSecret = secretFromOtpauthUri(/URI:\s+(otpauth:\/\/\S+)/.exec(first.stdout)?.[1] ?? '');

    const reset = seed(['--name', 'Seed Owner', '--password-stdin', '--auto-verify', '--reset'], 'a-brand-new-password-77');
    expect(reset.status, reset.stderr).toBe(0);
    const newSecret = secretFromOtpauthUri(/URI:\s+(otpauth:\/\/\S+)/.exec(reset.stdout)?.[1] ?? '');
    expect(newSecret).not.toBe(oldSecret);

    await expect(signInOwner({ email: ownerEmail(), password, totpCode: totp(oldSecret) })).rejects.toThrow();
    const { cookie } = await signInOwner({ email: ownerEmail(), password: 'a-brand-new-password-77', totpCode: totp(newSecret) });
    expect(await checkOwner(headersWith(cookie))).toMatchObject({ ok: true });
  });

  it('rejects a short password and does not create anything', async () => {
    const result = seed(['--name', 'Seed Owner', '--password-stdin', '--auto-verify'], 'short');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('at least 12');
    expect(await admin`SELECT 1 FROM auth_user`).toHaveLength(0);
  });

  it('keeps a business name edited later when the owner re-seeds with --reset', async () => {
    seed(['--name', 'Seed Owner', '--password-stdin', '--auto-verify'], password);
    await admin`UPDATE settings SET business_name = 'Renamed Business' WHERE id = 1`;
    const reset = seed(['--name', 'Seed Owner', '--password-stdin', '--auto-verify', '--reset'], 'a-brand-new-password-77');
    expect(reset.status, reset.stderr).toBe(0);
    const [row] = await getDb().select().from(settings);
    expect(row?.businessName).toBe('Renamed Business');
  });
});
