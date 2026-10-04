import { createOwnerUser, beginTotpEnrollment, signInOwner } from '@/lib/owner';
import { secretFromOtpauthUri, totp } from '@/lib/totp';

export const OWNER_PASSWORD = 'correct-horse-battery-staple';

export function ownerEmail(): string {
  const email = process.env.OWNER_EMAIL;
  if (!email) throw new Error('OWNER_EMAIL is not set (test/setup/env.ts should have provided it)');
  return email;
}

export interface EnrolledOwner {
  userId: string;
  email: string;
  password: string;
  /** Base32 TOTP secret, for generating codes. */
  secret: string;
  backupCodes: string[];
  /** `Cookie` header of a fully authenticated session (password + TOTP). */
  cookie: string;
}

/** Creates the owner, enrolls and confirms TOTP through Better Auth's real endpoints, and signs in. */
export async function createEnrolledOwner(): Promise<EnrolledOwner> {
  const email = ownerEmail();
  const created = await createOwnerUser({ email, name: 'Test Owner', password: OWNER_PASSWORD });
  const enrollment = await beginTotpEnrollment({ email, password: OWNER_PASSWORD });
  const secret = secretFromOtpauthUri(enrollment.totpURI);
  await enrollment.confirm(totp(secret));
  const { cookie } = await signInOwner({ email, password: OWNER_PASSWORD, totpCode: totp(secret) });
  return { userId: created.userId, email, password: OWNER_PASSWORD, secret, backupCodes: enrollment.backupCodes, cookie };
}

export function headersWith(cookie: string): Headers {
  return new Headers(cookie ? { cookie } : {});
}
