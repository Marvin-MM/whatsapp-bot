import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE } from '../helpers/fixtures';
import { seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

/**
 * scripts/backup.sh and scripts/restore.sh, run for real against the test database and a second, empty one (wab_restore_test). This is the
 * restore drill in miniature: a backup is only worth the proof that it restores, so the proof runs in CI, not once on someone's laptop.
 */
const h = setupIngestHarness();
const sql = () => h.admin();

const SOURCE_URL = process.env.DATABASE_MIGRATION_URL ?? '';
const TARGET_URL = SOURCE_URL.replace(/\/wab_test(\?|$)/, '/wab_restore_test$1');
const BACKUP = join(process.cwd(), 'scripts/backup.sh');
const RESTORE = join(process.cwd(), 'scripts/restore.sh');
const execFileAsync = promisify(execFile);
const HAS_AGE = spawnSync('age', ['--version']).status === 0;

let target: Sql;
const scratch: string[] = [];

beforeAll(async () => {
  if (TARGET_URL === SOURCE_URL) throw new Error('DATABASE_MIGRATION_URL must point at the wab_test database');
  target = postgres(TARGET_URL, { max: 1, onnotice: () => undefined });
  try {
    await target`SELECT 1`;
  } catch (error) {
    throw new Error(`the wab_restore_test database is missing or unreachable (${String(error)}). Run: psql -f scripts/db-init/01-roles.sql as a Postgres superuser (it is idempotent).`);
  }
});

afterAll(async () => {
  await target.end({ timeout: 5 });
});

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wab-${label}-`));
  scratch.push(dir);
  return dir;
}

/** Leaves the restore target empty, as a fresh Postgres first start would. */
async function emptyTarget(): Promise<void> {
  await target.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await target.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await target.unsafe('CREATE SCHEMA public');
}

interface Run {
  status: number | null;
  out: string;
  err: string;
}

/** A minimal environment for the scripts: what they need to find their tools, plus the settings under test. */
function scriptEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extra };
}

function run(script: string, args: string[], env: Record<string, string>): Run {
  const result = spawnSync('bash', [script, ...args], { env: scriptEnv(env), encoding: 'utf8', timeout: 90_000 });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

function makeMedia(): string {
  const dir = join(tempDir('media'), 'media');
  mkdirSync(join(dir, '2026', '10'), { recursive: true });
  writeFileSync(join(dir, '2026', '10', 'voice.ogg'), Buffer.from([1, 2, 3, 4, 5]));
  writeFileSync(join(dir, '2026', '10', 'photo.jpg'), Buffer.from([9, 8, 7]));
  return dir;
}

interface Setup {
  backups: string;
  media: string;
  env: Record<string, string>;
}

function setup(extra: Record<string, string> = {}): Setup {
  const backups = tempDir('backups');
  const media = makeMedia();
  return { backups, media, env: { BACKUP_DATABASE_URL: SOURCE_URL, BACKUP_DIR: backups, BACKUP_MEDIA_DIR: media, ...extra } };
}

const folders = (dir: string) => readdirSync(dir).sort();

async function seed(): Promise<void> {
  const contact = await seedContact(sql(), { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid, name: 'Amina' });
  const conv = await seedConversation(sql(), contact, { status: 'waiting_on_me', summary: 'Wants two bags of cement' });
  await seedMessage(sql(), conv, { direction: 'inbound', content: 'How much for two bags?', wamid: 'wamid.BR1' });
  await seedMessage(sql(), conv, { direction: 'outbound', status: 'sent', content: 'UGX 40,000 each.', wamid: 'wamid.BR2' });
  await seedMessage(sql(), conv, { direction: 'inbound', content: 'Deliver to Ntinda please', wamid: 'wamid.BR3' });
}

const messagesDigest = (db: Sql) => db<{ n: string; digest: string }[]>`SELECT count(*)::text AS n, md5(string_agg(m::text, '' ORDER BY id)) AS digest FROM messages m`;

function restoreEnv(media: string, extra: Record<string, string> = {}): Record<string, string> {
  return { RESTORE_DATABASE_URL: TARGET_URL, RESTORE_MEDIA_DIR: media, ...extra };
}

describe('backup then restore', () => {
  it('reproduces every row (byte for byte) and every media file, and proves it', async () => {
    await seed();
    const s = setup();
    const backup = run(BACKUP, [], s.env);
    expect(backup.status, backup.err).toBe(0);
    const [folder] = folders(s.backups);
    expect(folder).toMatch(/^\d{8}T\d{6}Z$/);
    expect(folders(join(s.backups, folder ?? ''))).toEqual(['SHA256SUMS', 'counts.txt', 'db.dump', 'media-files.txt', 'media.tar']);

    await emptyTarget();
    const mediaTarget = join(tempDir('restored'), 'media');
    const restore = run(RESTORE, [join(s.backups, folder ?? '')], restoreEnv(mediaTarget));
    expect(restore.status, restore.err).toBe(0);
    expect(restore.out).toMatch(/RESTORE VERIFIED: \d+ tables, \d+ rows all equal the backup; 2 media files\./);

    expect(await messagesDigest(target)).toEqual(await messagesDigest(sql()));
    expect(readFileSync(join(mediaTarget, '2026', '10', 'voice.ogg'))).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(readFileSync(join(mediaTarget, '2026', '10', 'photo.jpg'))).toEqual(Buffer.from([9, 8, 7]));
  });

  it('keeps the runtime role limited after a restore (grants travel with the dump: append-only audit log, no DDL)', async () => {
    await seed();
    const s = setup();
    expect(run(BACKUP, [], s.env).status).toBe(0);
    await emptyTarget();
    const [folder] = folders(s.backups);
    const restore = run(RESTORE, [join(s.backups, folder ?? '')], restoreEnv(join(tempDir('restored'), 'media')));
    expect(restore.status, restore.err).toBe(0);
    const [privileges] = await target<{ ins: boolean; upd: boolean; del: boolean; sel: boolean }[]>`
      SELECT has_table_privilege('wab_app', 'audit_log', 'INSERT') AS ins, has_table_privilege('wab_app', 'audit_log', 'UPDATE') AS upd,
             has_table_privilege('wab_app', 'audit_log', 'DELETE') AS del, has_table_privilege('wab_app', 'messages', 'SELECT') AS sel`;
    expect(privileges).toEqual({ ins: true, upd: false, del: false, sel: true });
  });

  it('is consistent while messages keep arriving: the dump and the counts describe the same instant', async () => {
    await seed();
    await sql().unsafe('CREATE TABLE backup_noise (id bigserial PRIMARY KEY, v text)');
    let stop = false;
    const writer = (async () => {
      while (!stop) await sql().unsafe('INSERT INTO backup_noise (v) SELECT md5(random()::text) FROM generate_series(1, 25)');
    })();
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const s = setup();
      // Asynchronous, so the writer above keeps inserting WHILE the backup runs.
      const backup = await execFileAsync('bash', [BACKUP], { env: scriptEnv(s.env), encoding: 'utf8' }).then(
        (done): Run => ({ status: 0, out: done.stdout, err: done.stderr }),
        (failed: { code?: number; stdout?: string; stderr?: string }): Run => ({ status: failed.code ?? 1, out: failed.stdout ?? '', err: failed.stderr ?? '' }),
      );
      expect(backup.status, backup.err).toBe(0);
      const [folder] = folders(s.backups);
      expect(readFileSync(join(s.backups, folder ?? '', 'counts.txt'), 'utf8')).toMatch(/public\.backup_noise\|[1-9]\d*/);
      stop = true;
      await writer;
      await emptyTarget();
      const restore = run(RESTORE, [join(s.backups, folder ?? '')], restoreEnv(join(tempDir('restored'), 'media')));
      expect(restore.status, restore.out + restore.err).toBe(0);
      expect(restore.out).toContain('RESTORE VERIFIED');
    } finally {
      stop = true;
      await writer;
      await sql().unsafe('DROP TABLE IF EXISTS backup_noise');
    }
  });
});

describe('restore refuses to do harm', () => {
  async function backedUp(extra: Record<string, string> = {}): Promise<{ s: Setup; folder: string }> {
    await seed();
    const s = setup(extra);
    const backup = run(BACKUP, [], s.env);
    expect(backup.status, backup.err).toBe(0);
    const [name] = folders(s.backups);
    return { s, folder: join(s.backups, name ?? '') };
  }

  it('will not restore into a database that already holds tables, and changes nothing there', async () => {
    const { folder } = await backedUp();
    await emptyTarget();
    expect(run(RESTORE, [folder], restoreEnv(join(tempDir('restored'), 'media'))).status).toBe(0);
    const before = await messagesDigest(target);
    const again = run(RESTORE, [folder], restoreEnv(join(tempDir('restored'), 'media')));
    expect(again.status).toBe(1);
    expect(again.err).toMatch(/already has \d+ tables/);
    expect(await messagesDigest(target)).toEqual(before);
  });

  it('will not restore into a media directory that already holds files', async () => {
    const { folder } = await backedUp();
    await emptyTarget();
    const occupied = makeMedia();
    const result = run(RESTORE, [folder], restoreEnv(occupied));
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/not empty/);
    expect(await target`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'`).toHaveLength(0);
  });

  it('rejects a backup whose bytes changed (checksum) before touching the target', async () => {
    const { folder } = await backedUp();
    const dump = join(folder, 'db.dump');
    const bytes = readFileSync(dump);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 1;
    writeFileSync(dump, bytes);
    await emptyTarget();
    const result = run(RESTORE, [folder], restoreEnv(join(tempDir('restored'), 'media')));
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/do not match their checksums/);
    const rows = await target`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'`;
    expect(rows).toHaveLength(0);
  });

  it('reports a row-count mismatch instead of declaring success', async () => {
    const { folder } = await backedUp();
    const counts = join(folder, 'counts.txt');
    writeFileSync(counts, readFileSync(counts, 'utf8').replace(/^public\.messages\|3$/m, 'public.messages|4'));
    const sums = spawnSync('bash', ['-c', 'sha256sum -- db.dump media.tar counts.txt media-files.txt > SHA256SUMS'], { cwd: folder });
    expect(sums.status).toBe(0);
    await emptyTarget();
    const result = run(RESTORE, [folder], restoreEnv(join(tempDir('restored'), 'media')));
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/MISMATCH/);
    expect(result.err).toMatch(/-public\.messages\|4/);
    expect(result.out).not.toContain('RESTORE VERIFIED');
  });
});

describe('restore stops cleanly when the backup is damaged in a way checksums cannot see', () => {
  async function damaged(change: (folder: string) => void): Promise<Run> {
    await seed();
    const s = setup();
    expect(run(BACKUP, [], s.env).status).toBe(0);
    const [name] = folders(s.backups);
    const folder = join(s.backups, name ?? '');
    change(folder);
    // Re-seal the folder as if the damage had happened before the backup was checksummed.
    expect(spawnSync('bash', ['-c', 'sha256sum -- db.dump media.tar counts.txt media-files.txt > SHA256SUMS'], { cwd: folder }).status).toBe(0);
    await emptyTarget();
    return run(RESTORE, [folder], restoreEnv(join(tempDir('restored'), 'media')));
  }

  it('never claims success for a dump that was cut short, and leaves no half-restored database behind', async () => {
    const result = await damaged((folder) => {
      const dump = readFileSync(join(folder, 'db.dump'));
      writeFileSync(join(folder, 'db.dump'), dump.subarray(0, Math.floor(dump.length * 0.6)));
    });
    expect(result.status).not.toBe(0);
    expect(result.out).not.toContain('RESTORE VERIFIED');
    expect(await target`SELECT 1 FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle')`).toHaveLength(0);
  });

  it('reports a media archive that holds fewer files than the backup recorded', async () => {
    const result = await damaged((folder) => writeFileSync(join(folder, 'media-files.txt'), '3\n'));
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/recorded 3 media files, 2 were restored/);
    expect(result.out).not.toContain('RESTORE VERIFIED');
  });
});

describe('backup refuses to produce something misleading', () => {
  it('fails, and leaves no folder behind, when the media directory is missing (a typo must not give media-less backups)', () => {
    const s = setup({ BACKUP_MEDIA_DIR: '/definitely/not/here' });
    const result = run(BACKUP, [], s.env);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/media directory .* does not exist/);
    expect(folders(s.backups)).toEqual([]);
  });

  it('can be told that a fresh install has no media yet', async () => {
    await seed();
    const s = setup({ BACKUP_MEDIA_DIR: '/definitely/not/here', BACKUP_ALLOW_NO_MEDIA: 'yes' });
    const result = run(BACKUP, [], s.env);
    expect(result.status, result.err).toBe(0);
    const [folder] = folders(s.backups);
    expect(folders(join(s.backups, folder ?? ''))).not.toContain('media.tar');
  });

  it('fails clearly, leaving nothing, when the database cannot be reached', () => {
    const s = setup({ BACKUP_DATABASE_URL: SOURCE_URL.replace(/:[^:@/]+@/, ':wrong-password@') });
    const result = run(BACKUP, [], s.env);
    expect(result.status).toBe(1);
    expect(result.err).toMatch(/could not open a snapshot/);
    expect(folders(s.backups)).toEqual([]);
  });

  it('says so, loudly, when the backup is neither encrypted nor copied off the server', async () => {
    await seed();
    const result = run(BACKUP, [], setup().env);
    expect(result.status, result.err).toBe(0);
    expect(result.err).toMatch(/NO OFF-SERVER COPY/);
    expect(result.err).toMatch(/NOT encrypted/);
  });

  it('refuses to upload unencrypted customer data unless explicitly allowed', () => {
    const bin = tempDir('bin');
    const rclone = join(bin, 'rclone');
    writeFileSync(rclone, '#!/bin/sh\nexit 0\n');
    chmodSync(rclone, 0o755);
    const s = setup({ BACKUP_RCLONE_REMOTE: 'offsite:wab', PATH: `${bin}:${process.env.PATH ?? ''}` });
    const result = run(BACKUP, [], s.env);
    expect(result.status).toBe(2);
    expect(result.err).toMatch(/refusing to upload unencrypted/);
    expect(folders(s.backups)).toEqual([]);
  });
});

describe('retention', () => {
  it('keeps the newest N complete backups and never touches anything else in the folder', async () => {
    await seed();
    const s = setup({ BACKUP_KEEP: '2' });
    mkdirSync(join(s.backups, 'not-a-backup'));
    mkdirSync(join(s.backups, '29990101T000000Z')); // looks like a backup but is incomplete (no checksum file): never counts, never removed
    for (let i = 0; i < 3; i += 1) {
      const result = run(BACKUP, [], s.env);
      expect(result.status, result.err).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
    const names = folders(s.backups);
    expect(names).toContain('not-a-backup');
    expect(names).toContain('29990101T000000Z');
    expect(names.filter((name) => existsSync(join(s.backups, name, 'SHA256SUMS')))).toHaveLength(2);
  }, 60_000);
});

describe.skipIf(!HAS_AGE)('encrypted backups (needs the `age` tool)', () => {
  function keypair(): { identity: string; recipient: string } {
    const dir = tempDir('age');
    const identity = join(dir, 'key.txt');
    const result = spawnSync('age-keygen', ['-o', identity], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const recipient = /age1[a-z0-9]+/.exec(result.stderr + readFileSync(identity, 'utf8'))?.[0];
    if (!recipient) throw new Error('age-keygen produced no public key');
    return { identity, recipient };
  }

  it('stores no plaintext, restores with the right key, and with the wrong key leaves the target untouched', async () => {
    await seed();
    const mine = keypair();
    const s = setup({ BACKUP_AGE_RECIPIENT: mine.recipient });
    const backup = run(BACKUP, [], s.env);
    expect(backup.status, backup.err).toBe(0);
    expect(backup.err).not.toMatch(/NOT encrypted/);
    const [name] = folders(s.backups);
    const folder = join(s.backups, name ?? '');
    expect(folders(folder)).toEqual(['SHA256SUMS', 'counts.txt', 'db.dump.age', 'media-files.txt', 'media.tar.age']);
    expect(readFileSync(join(folder, 'db.dump.age')).includes('Amina')).toBe(false);

    await emptyTarget();
    const wrong = run(RESTORE, [folder], restoreEnv(join(tempDir('restored'), 'media'), { BACKUP_AGE_IDENTITY: keypair().identity }));
    expect(wrong.status).toBe(1);
    expect(wrong.err).toMatch(/could not decrypt/);
    expect(await target`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'`).toHaveLength(0);

    const none = run(RESTORE, [folder], restoreEnv(join(tempDir('restored'), 'media')));
    expect(none.status).toBe(1);
    expect(none.err).toMatch(/BACKUP_AGE_IDENTITY/);

    const right = run(RESTORE, [folder], restoreEnv(join(tempDir('restored'), 'media'), { BACKUP_AGE_IDENTITY: mine.identity }));
    expect(right.status, right.err).toBe(0);
    expect(right.out).toContain('RESTORE VERIFIED');
    expect(await messagesDigest(target)).toEqual(await messagesDigest(sql()));
  });
});
