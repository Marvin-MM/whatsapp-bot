import 'server-only';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { settings } from '@/lib/db/schema';

export const MAX_PROFILE_CHARS = 8000;

const name = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(80, `${label} is at most 80 characters.`)
    .refine((value) => !/[\u0000-\u001f<>]/.test(value), `${label} cannot contain line breaks or angle brackets.`);

export const businessProfileSchema = z.object({
  ownerName: name('Your name'),
  businessName: name('Business name'),
  businessProfile: z
    .string()
    .max(MAX_PROFILE_CHARS, `The profile is at most ${MAX_PROFILE_CHARS} characters.`)
    .refine((value) => !value.includes('\u0000'), 'The profile cannot contain NUL characters.'),
});
export type ProfileInput = z.infer<typeof businessProfileSchema>;

/** Upserts the singleton settings row; returns what was there before (for the audit entry). */
export async function applyBusinessProfile(tx: Tx, input: ProfileInput): Promise<ProfileInput | null> {
  const [before] = await tx.select({ ownerName: settings.ownerName, businessName: settings.businessName, businessProfile: settings.businessProfile }).from(settings).where(eq(settings.id, 1)).limit(1);
  const values = { ownerName: input.ownerName, businessName: input.businessName, businessProfile: input.businessProfile.replace(/\r\n?/g, '\n') };
  await tx
    .insert(settings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: settings.id, set: { ...values, updatedAt: new Date() } });
  return before ?? null;
}
