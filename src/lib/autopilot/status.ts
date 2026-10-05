import 'server-only';
import { eq } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { settings } from '@/lib/db/schema';
import { type GateCheck, getEligibility } from './eligibility';

/** What the screens need to know about autopilot as a whole: is it on, may it be turned on, and every check with its numbers. */
export interface AutopilotStatus {
  /** The kill switch (`autopilot_paused`): true until the owner turns autopilot on, which the gate must allow. */
  paused: boolean;
  /** The eligibility gate passes right now. */
  eligible: boolean;
  checks: GateCheck[];
  /** The checks that fail, for a short "why not" under a disabled control. */
  failed: GateCheck[];
}

export async function getAutopilotStatus(db: Db, now: Date = new Date()): Promise<AutopilotStatus> {
  const [row] = await db.select({ paused: settings.autopilotPaused }).from(settings).where(eq(settings.id, 1)).limit(1);
  const eligibility = await getEligibility(db, now);
  return { paused: row?.paused ?? true, eligible: eligibility.eligible, checks: eligibility.checks, failed: eligibility.checks.filter((check) => !check.ok) };
}
