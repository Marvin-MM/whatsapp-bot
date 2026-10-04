import postgres, { type Sql } from 'postgres';
import { closeDb } from '@/lib/db';

function requireEnv(name: 'DATABASE_URL' | 'DATABASE_MIGRATION_URL'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (test/setup/env.ts should have provided it)`);
  return value;
}

const opened: Sql[] = [];

function open(url: string): Sql {
  const sql = postgres(url, { max: 2, onnotice: () => undefined });
  opened.push(sql);
  return sql;
}

/** Connection as the migration role (table owner): used for fixtures and truncation. */
export function migratorSql(): Sql {
  const url = requireEnv('DATABASE_MIGRATION_URL');
  assertTestDatabase(url);
  return open(url);
}

/** Connection as the least-privilege app role: used to prove what the app may and may not do. */
export function appSql(): Sql {
  const url = requireEnv('DATABASE_URL');
  assertTestDatabase(url);
  return open(url);
}

export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to touch database "${name}": integration tests require a name ending in _test`);
  }
}

/** Empties every application table (keeps the migrations bookkeeping in the drizzle schema). */
export async function resetDb(sql: Sql): Promise<void> {
  const rows = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  if (rows.length === 0) return;
  const list = rows.map((row) => `"public"."${row.tablename}"`).join(', ');
  await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/** Closes the shared app client and every connection opened through this module. */
export async function closeAllDb(): Promise<void> {
  await closeDb();
  await Promise.all(opened.splice(0).map((sql) => sql.end({ timeout: 5 })));
}

/** Extracts a Postgres error code from a raw postgres.js error or a Drizzle-wrapped one. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? undefined : pgErrorCode(cause);
}

/** Asserts a promise rejects with the given Postgres SQLSTATE (e.g. 23505 unique, 23514 check, 42501 privilege). */
export async function expectPgError(promise: PromiseLike<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`Expected Postgres error ${code}, but the statement succeeded`);
  const actual = pgErrorCode(caught);
  if (actual !== code) {
    throw new Error(`Expected Postgres error ${code}, got ${actual ?? 'a non-Postgres error'}: ${String(caught)}`);
  }
}
