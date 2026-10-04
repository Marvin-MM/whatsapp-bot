import 'server-only';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { getEnv } from '@/lib/env';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Anything that can run queries: the pool or a transaction. */
export type DbOrTx = Db | Tx;

interface DbHandle {
  sql: Sql;
  db: Db;
}

// In development Next re-evaluates modules on every edit; cache on globalThis to avoid leaking pools.
const globalForDb = globalThis as unknown as { __wabDb?: DbHandle };

let handle: DbHandle | undefined;

function open(): DbHandle {
  const env = getEnv();
  const sql = postgres(env.DATABASE_URL, {
    // Transaction-mode poolers (e.g. PgBouncer) do not support prepared statements.
    prepare: env.DATABASE_POOLER !== 'transaction',
    max: 10,
  });
  return { sql, db: drizzle(sql, { schema }) };
}

/** The shared app-role database client (lazy so importing never forces env validation). */
export function getDb(): Db {
  if (getEnv().NODE_ENV === 'development') {
    globalForDb.__wabDb ??= open();
    return globalForDb.__wabDb.db;
  }
  handle ??= open();
  return handle.db;
}

/** Closes the pool; used by worker shutdown and tests. */
export async function closeDb(): Promise<void> {
  const current = handle ?? globalForDb.__wabDb;
  handle = undefined;
  globalForDb.__wabDb = undefined;
  await current?.sql.end({ timeout: 5 });
}

export { schema };
