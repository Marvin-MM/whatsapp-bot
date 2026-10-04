import 'server-only';
import { eq } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import { getAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { session, twoFactor, user } from '@/lib/db/auth-schema';

/**
 * Owner lifecycle used by `pnpm seed:owner` and by tests. Sign-up is disabled over HTTP, so the one
 * owner account is created here through Better Auth's internal adapter, and TOTP is enrolled through
 * its real endpoints (so secrets are encrypted exactly the way the plugin expects).
 */

/** Turns Set-Cookie headers into a request `Cookie` header (name=value pairs only). */
export function cookieHeaderFromSetCookies(setCookies: readonly string[]): string {
  return setCookies
    .map((line) => line.split(';')[0]?.trim() ?? '')
    .filter((pair) => pair.includes('=') && !pair.endsWith('='))
    .join('; ');
}

export type CreateOwnerResult = { created: true; userId: string } | { created: false; userId: string };

/** Creates the owner with a credential account. If the user already exists nothing is changed. */
export async function createOwnerUser(input: { email: string; name: string; password: string }): Promise<CreateOwnerResult> {
  const ctx = await getAuth().$context;
  const existing = await ctx.internalAdapter.findUserByEmail(input.email);
  if (existing) return { created: false, userId: existing.user.id };

  const passwordHash = await ctx.password.hash(input.password);
  const created = await ctx.internalAdapter.createUser(
    { email: input.email, name: input.name, emailVerified: true },
    { method: 'owner-seed' },
  );
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: passwordHash,
  });
  await writeAudit(getDb(), { actor: 'system', action: 'owner.create', entityType: 'user', entityId: created.id });
  return { created: true, userId: created.id };
}

/** Lost authenticator: set a new password, remove TOTP, and revoke every session. */
export async function resetOwnerCredentials(input: { userId: string; password: string }): Promise<void> {
  const ctx = await getAuth().$context;
  const passwordHash = await ctx.password.hash(input.password);
  await ctx.internalAdapter.updatePassword(input.userId, passwordHash);
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(twoFactor).where(eq(twoFactor.userId, input.userId));
    await tx.update(user).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(user.id, input.userId));
    await tx.delete(session).where(eq(session.userId, input.userId));
    await writeAudit(tx, { actor: 'system', action: 'owner.reset_credentials', entityType: 'user', entityId: input.userId });
  });
}

export interface TotpEnrollment {
  /** otpauth:// URI for authenticator apps. */
  totpURI: string;
  /** One-time backup codes; shown once, stored only as hashes/encrypted. */
  backupCodes: string[];
  /** Completes enrollment with a code from the authenticator; until then TOTP is not enforced. */
  confirm: (code: string) => Promise<void>;
}

/** Starts TOTP enrollment for an owner who has no second factor yet. */
export async function beginTotpEnrollment(input: { email: string; password: string }): Promise<TotpEnrollment> {
  const auth = getAuth();
  const signedIn = await auth.api.signInEmail({
    body: { email: input.email, password: input.password },
    returnHeaders: true,
  });
  if ('twoFactorRedirect' in signedIn.response && signedIn.response.twoFactorRedirect) {
    throw new Error('TOTP is already enrolled for this user; use --reset to start over');
  }
  const headers = new Headers({ cookie: cookieHeaderFromSetCookies(signedIn.headers.getSetCookie()) });
  const enabled = await auth.api.enableTwoFactor({ body: { password: input.password }, headers });
  if (enabled.method !== 'totp') throw new Error(`expected a TOTP enrollment, got method "${enabled.method}"`);

  return {
    totpURI: enabled.totpURI,
    backupCodes: enabled.backupCodes,
    confirm: async (code: string) => {
      await auth.api.verifyTOTP({ body: { code }, headers });
    },
  };
}

/**
 * Full owner sign-in (password, then TOTP). Returns the session `Cookie` header.
 * Used by tests; the browser flow does the same two calls through the login page.
 */
export async function signInOwner(input: { email: string; password: string; totpCode: string }): Promise<{ cookie: string }> {
  const auth = getAuth();
  const first = await auth.api.signInEmail({ body: { email: input.email, password: input.password }, returnHeaders: true });
  const challengeCookie = cookieHeaderFromSetCookies(first.headers.getSetCookie());
  if (!('twoFactorRedirect' in first.response) || !first.response.twoFactorRedirect) {
    return { cookie: challengeCookie };
  }
  const verified = await auth.api.verifyTOTP({
    body: { code: input.totpCode },
    headers: new Headers({ cookie: challengeCookie }),
    returnHeaders: true,
  });
  return { cookie: cookieHeaderFromSetCookies(verified.headers.getSetCookie()) };
}
