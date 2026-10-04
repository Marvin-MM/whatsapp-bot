import { getMigrationEnv } from '@/lib/env';
import { runMigrations } from '@/lib/db/migrate';

const { DATABASE_MIGRATION_URL } = getMigrationEnv();

await runMigrations(DATABASE_MIGRATION_URL);
process.stdout.write('migrations applied\n');
