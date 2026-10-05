'use server';

import type { ActionResult } from '@/lib/actions/owner-action-core';
import { applyBusinessProfile, businessProfileSchema } from '@/lib/settings/profile';
import { ownerAction } from './owner-action';

const save = ownerAction({
  name: 'settings.profile',
  schema: businessProfileSchema,
  handler: async ({ input, tx }) => {
    const previous = await applyBusinessProfile(tx, input);
    return {
      data: { saved: true as const },
      // Lengths only: the profile can hold prices and policies, and the audit log is not a second copy of the settings.
      audit: {
        action: 'settings.profile',
        entityType: 'settings',
        entityId: '1',
        metadata: { profileChars: input.businessProfile.length, previousProfileChars: previous?.businessProfile.length ?? null, ownerNameChanged: previous?.ownerName !== input.ownerName, businessNameChanged: previous?.businessName !== input.businessName },
      },
    };
  },
});

/** Saves the owner's name, the business name and the business profile (the ONLY source of facts the assistant may state). Owner-only, audited. */
export async function saveBusinessProfile(input: unknown): Promise<ActionResult<{ saved: true }>> {
  return save(input);
}
