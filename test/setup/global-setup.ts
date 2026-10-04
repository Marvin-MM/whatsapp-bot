import { runMigrations } from '../../src/lib/db/migrate';
import { TEST_ENV_DEFAULTS } from './env';

// Runs once before the integration suite: bring the test database to the latest migration.
// Requires the roles and databases from scripts/db-init/01-roles.sql to exist.
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL ?? TEST_ENV_DEFAULTS.DATABASE_MIGRATION_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL is not set for integration tests');
  assertTestDatabase(url);
  await runMigrations(url);
}

/** Integration tests TRUNCATE tables; refuse to run against anything that is not clearly a test database. */
function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run integration tests against database "${name}": name must end with _test`);
  }
}
