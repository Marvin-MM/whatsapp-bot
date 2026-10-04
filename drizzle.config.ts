import { defineConfig } from 'drizzle-kit';

// Used for `drizzle-kit generate` only (no database connection needed).
// Migrations are applied by scripts/migrate.ts with the migration role, never during `next build`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
});
