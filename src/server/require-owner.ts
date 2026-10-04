import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { type OwnerSession, checkOwner } from '@/lib/auth-guard';

/**
 * Page-level authorization. Layouts do not re-run on client navigation and proxy.ts only checks that a
 * cookie exists, so EVERY dashboard page calls this itself (defense in depth, per the Next data-security guide).
 */
export async function requireOwnerPage(): Promise<OwnerSession> {
  const check = await checkOwner(await headers());
  if (!check.ok) {
    redirect(check.reason === 'two_factor_required' ? '/login?error=two_factor_required' : '/login');
  }
  return check.owner;
}
