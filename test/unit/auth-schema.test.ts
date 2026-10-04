import { getAuthTables } from 'better-auth/db';
import { twoFactor as twoFactorPlugin } from 'better-auth/plugins/two-factor';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as authSchema from '@/lib/db/auth-schema';

/**
 * The auth tables are hand-translated from the installed Better Auth version (its CLI lags the library).
 * This test re-reads the library's own table definitions so an upgrade that adds, renames or
 * requires a field fails here instead of in production.
 */
const expected = getAuthTables({
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: 'database' },
  plugins: [twoFactorPlugin({ issuer: 'test' })],
});

const tables: Record<string, PgTable> = {
  user: authSchema.user,
  session: authSchema.session,
  account: authSchema.account,
  verification: authSchema.verification,
  twoFactor: authSchema.twoFactor,
  rateLimit: authSchema.rateLimit,
};

describe('auth schema matches Better Auth', () => {
  it('defines every table Better Auth expects for our plugin set', () => {
    expect(Object.keys(tables).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [model, definition] of Object.entries(expected)) {
    describe(model, () => {
      const columns = getTableColumns(tables[model] as PgTable);

      it('has an id primary key', () => {
        expect(columns.id?.primary).toBe(true);
      });

      for (const [field, spec] of Object.entries(definition.fields)) {
        const key = spec.fieldName ?? field;

        it(`has column "${key}" with compatible nullability`, () => {
          const column = columns[key];
          expect(column, `missing column for field ${key}`).toBeDefined();
          // A field Better Auth requires with no default must be NOT NULL; optional fields may be either.
          if (spec.required !== false && spec.defaultValue === undefined) {
            expect(column?.notNull, `${key} should be NOT NULL`).toBe(true);
          }
          if (spec.required === false && spec.defaultValue === undefined) {
            expect(column?.notNull, `${key} should be nullable`).toBe(false);
          }
        });

        if (spec.unique) {
          it(`enforces uniqueness on "${key}"`, () => {
            expect(columns[key]?.isUnique, `${key} should be unique`).toBe(true);
          });
        }
      }
    });
  }
});
