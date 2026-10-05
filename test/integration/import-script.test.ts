import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { count, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

function run(args: string[]): { status: number | null; out: string; err: string } {
  const result = spawnSync('pnpm', ['exec', 'tsx', '--conditions=react-server', 'scripts/import-chats.ts', ...args], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, timeout: 60_000, input: '' });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe('pnpm import:chats', () => {
  it('--help prints usage and writes nothing', () => {
    const { status, out } = run(['--help']);
    expect(status).toBe(0);
    expect(out).toMatch(/Usage: pnpm import:chats/);
  });

  it('--dry-run parses and reports but writes nothing', async () => {
    const { status, out } = run(['test/fixtures/exports/android-24h.txt', '--me', 'Marvin', '--dry-run']);
    expect(status).toBe(0);
    expect(out).toMatch(/would import 9 messages with "Amina Customer"/);
    expect(out).toMatch(/Dry run: nothing was written/);
    expect(await count(sql(), 'messages')).toBe(0);
  });

  it('imports a folder, reports per file, refuses the group chat without stopping the rest, and a re-run changes nothing', async () => {
    const first = run(['test/fixtures/exports', '--me', 'Marvin']);
    // the folder holds a group export, a contradictory file and one-sided/ambiguous ones: those are skipped with a reason, exit code 1
    expect(first.err).toMatch(/SKIPPED group\.txt: This looks like a group chat/);
    expect(first.err).toMatch(/SKIPPED contradictory\.txt/);
    expect(first.out).toMatch(/android-24h\.txt: 8 imported \(3 yours, 5 theirs\), 1 deleted skipped, 1 photos\/files noted \(new contact\)/);
    expect(first.status).toBe(1);
    const afterFirst = await count(sql(), 'messages');
    expect(afterFirst).toBeGreaterThan(8);

    const second = run(['test/fixtures/exports', '--me', 'Marvin']);
    expect(second.out).toMatch(/android-24h\.txt: 0 imported .*8 already imported/);
    expect(await count(sql(), 'messages')).toBe(afterFirst);
  });

  it('warns about a file whose dates are all ambiguous', () => {
    const { out } = run(['test/fixtures/exports/ambiguous.txt', '--me', 'Marvin', '--dry-run']);
    expect(out).toMatch(/WARNING ambiguous\.txt: Every date in this file is ambiguous/);
  });

  it('without --me and without a terminal it refuses instead of guessing who you are', async () => {
    const { status, err } = run(['test/fixtures/exports/android-24h.txt']);
    expect(status).toBe(1);
    expect(err).toMatch(/Pass --me/);
    expect(await count(sql(), 'messages')).toBe(0);
  });

  it('refuses --contact for more than one file, a bad --date-order, and a missing path', () => {
    expect(run(['test/fixtures/exports', '--me', 'Marvin', '--contact', '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee']).err).toMatch(/ONE chat/);
    expect(run(['test/fixtures/exports/android-24h.txt', '--me', 'Marvin', '--date-order', 'ymd']).err).toMatch(/dmy or mdy/);
    expect(run(['test/fixtures/exports/nope.txt', '--me', 'Marvin']).err).toMatch(/No such file/);
  });
});
