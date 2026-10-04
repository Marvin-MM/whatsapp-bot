import 'server-only';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { getDb } from '@/lib/db';
import * as authSchema from '@/lib/db/auth-schema';
import { getEnv } from '@/lib/env';
import { uuidv7 } from '@/lib/ids';

const FIFTEEN_MINUTES = 15 * 60;

/** Paths (relative to /api/auth) with the spec's login limit: 5 attempts / 15 min / IP. */
const LOGIN_RULE = { window: FIFTEEN_MINUTES, max: 5 };

function create() {
  const env = getEnv();
  return betterAuth({
    appName: 'WhatsApp Assistant',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(getDb(), { provider: 'pg', schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      // Single owner: created by `pnpm seed:owner`, never through the public sign-up endpoint.
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    plugins: [twoFactor({ issuer: 'WhatsApp Assistant' })],
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    // Stored in Postgres so a restart cannot reset the brute-force counter.
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': LOGIN_RULE,
        '/two-factor/verify-totp': LOGIN_RULE,
        '/two-factor/verify-backup-code': LOGIN_RULE,
      },
    },
    advanced: {
      database: { generateId: () => uuidv7() },
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
  });
}

export type Auth = ReturnType<typeof create>;

let instance: Auth | undefined;

/** Lazy so importing never forces env or DB access (e.g. during `next build`). */
export function getAuth(): Auth {
  instance ??= create();
  return instance;
}
