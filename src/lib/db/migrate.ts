import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** Applies pending SQL migrations from `drizzle/`. Run with the migration role, never during `next build`. */
export async function runMigrations(databaseUrl: string, migrationsFolder = 'drizzle'): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
