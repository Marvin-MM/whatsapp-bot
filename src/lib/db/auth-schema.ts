import { bigint, boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Better Auth tables (core + two-factor plugin + database-backed rate limiting).
 *
 * Hand-translated from `getAuthTables(...)` of the installed better-auth version rather than the
 * CLI generator (the CLI lags the library: 1.4.x vs 1.7.x). test/unit/auth-schema.test.ts re-reads
 * the library's own table definitions and fails if a field here is missing, so an upgrade that adds
 * a field cannot slip through silently.
 *
 * TS export names (user, session, account, verification, twoFactor, rateLimit) are the model names the
 * Drizzle adapter looks up; SQL names are prefixed `auth_` to avoid clashing with app tables and the
 * reserved word "user". Ids are text so the adapter may use any id format (we generate uuid v7).
 */

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const user = pgTable('auth_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const session = pgTable(
  'auth_session',
  {
    id: text('id').primaryKey(),
    expiresAt: tstz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Look up and revoke all sessions of one user.
    index('auth_session_user_idx').on(t.userId),
  ],
);

export const account = pgTable(
  'auth_account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tstz('access_token_expires_at'),
    refreshTokenExpiresAt: tstz('refresh_token_expires_at'),
    scope: text('scope'),
    /** Argon-style hash only; the plaintext password is never stored. */
    password: text('password'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Sign-in: find the credential account of a user.
    index('auth_account_user_idx').on(t.userId),
  ],
);

export const verification = pgTable(
  'auth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Verification lookup by identifier.
    index('auth_verification_identifier_idx').on(t.identifier),
  ],
);

export const twoFactor = pgTable(
  'auth_two_factor',
  {
    id: text('id').primaryKey(),
    /** Encrypted TOTP secret (encrypted with BETTER_AUTH_SECRET by the plugin). */
    secret: text('secret').notNull(),
    /** Encrypted JSON list of hashed backup codes. */
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** False until the first valid TOTP code confirms the authenticator was set up correctly. */
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: tstz('locked_until'),
  },
  (t) => [
    // Second-factor verification: find the factor row of the signing-in user.
    index('auth_two_factor_user_idx').on(t.userId),
  ],
);

export const rateLimit = pgTable('auth_rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});
