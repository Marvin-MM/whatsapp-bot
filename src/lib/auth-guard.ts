import 'server-only';
import { getAuth } from '@/lib/auth';
import { getEnv } from '@/lib/env';

export interface OwnerSession {
  userId: string;
  email: string;
  name: string;
  sessionId: string;
}

export type OwnerCheck =
  | { ok: true; owner: OwnerSession }
  | { ok: false; reason: 'unauthenticated' | 'not_owner' | 'two_factor_required' };

/**
 * The single authorization check used by server actions, route handlers and the SSE route.
 * proxy.ts only redirects; it is not an authorization layer (Server Functions skip it on excluded paths).
 *
 * A session is accepted only for the configured owner AND only when TOTP is enrolled: Better Auth
 * does not require 2FA by default, so "TOTP required" is enforced here.
 */
export async function checkOwner(headers: Headers): Promise<OwnerCheck> {
  const result = await getAuth().api.getSession({ headers });
  if (!result) return { ok: false, reason: 'unauthenticated' };

  const { user, session } = result;
  if (user.email.toLowerCase() !== getEnv().OWNER_EMAIL.toLowerCase()) return { ok: false, reason: 'not_owner' };
  if (!user.twoFactorEnabled) return { ok: false, reason: 'two_factor_required' };

  return { ok: true, owner: { userId: user.id, email: user.email, name: user.name, sessionId: session.id } };
}
