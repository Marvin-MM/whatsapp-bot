import 'server-only';
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { settings } from '@/lib/db/schema';
import { DRAFT_INTENTS } from '@/lib/ai/schemas';
import { NEVER_AUTOPILOT_INTENTS } from './policy';

/**
 * The autopilot's own settings (spec 12 Settings -> Autopilot). The limits can only be set inside a sane range, the allowed intents can never include
 * a complaint or a request for a person (rule 4 would refuse them anyway: the form does not offer them), and the disclosure can never be emptied
 * (spec 10.3) nor contain a placeholder marker (the send path would refuse every reply it was added to).
 */

/** Intents the owner may allow. */
export const ALLOWABLE_INTENTS = DRAFT_INTENTS.filter((intent) => !NEVER_AUTOPILOT_INTENTS.includes(intent));

export const DELAY_SECONDS = { min: 15, max: 1800 } as const;
export const MAX_DISCLOSURE_CHARS = 200;

export const autopilotSettingsSchema = z.object({
  delaySeconds: z.number().int().min(DELAY_SECONDS.min).max(DELAY_SECONDS.max),
  maxPerConversationPerHour: z.number().int().min(1).max(20),
  maxPerDay: z.number().int().min(1).max(200),
  maxConsecutive: z.number().int().min(1).max(20),
  allowedIntents: z.array(z.enum(ALLOWABLE_INTENTS as [string, ...string[]])).max(ALLOWABLE_INTENTS.length),
  disclosure: z
    .string()
    .trim()
    .min(1, 'The disclosure line cannot be empty: customers must be told it is automatic.')
    .max(MAX_DISCLOSURE_CHARS)
    .refine((text) => !text.includes('[['), 'The disclosure line cannot contain [[ (it would be mistaken for a placeholder).'),
});

export type AutopilotSettingsInput = z.infer<typeof autopilotSettingsSchema>;

/** Writes the settings and returns which fields changed (names only: the audit entry says what, not the disclosure's wording). */
export async function applyAutopilotSettings(tx: Tx, input: AutopilotSettingsInput): Promise<string[]> {
  const [before] = await tx.select().from(settings).limit(1);
  const next = {
    autopilotDelaySeconds: input.delaySeconds,
    autopilotMaxPerConversationPerHour: input.maxPerConversationPerHour,
    autopilotMaxPerDay: input.maxPerDay,
    autopilotMaxConsecutive: input.maxConsecutive,
    autopilotAllowedIntents: [...new Set(input.allowedIntents)],
    autopilotDisclosure: input.disclosure,
  };
  const changed: string[] = [];
  if (!before || before.autopilotDelaySeconds !== next.autopilotDelaySeconds) changed.push('delaySeconds');
  if (!before || before.autopilotMaxPerConversationPerHour !== next.autopilotMaxPerConversationPerHour) changed.push('maxPerConversationPerHour');
  if (!before || before.autopilotMaxPerDay !== next.autopilotMaxPerDay) changed.push('maxPerDay');
  if (!before || before.autopilotMaxConsecutive !== next.autopilotMaxConsecutive) changed.push('maxConsecutive');
  if (!before || [...before.autopilotAllowedIntents].sort().join() !== [...next.autopilotAllowedIntents].sort().join()) changed.push('allowedIntents');
  if (!before || before.autopilotDisclosure !== next.autopilotDisclosure) changed.push('disclosure');
  await tx
    .insert(settings)
    .values({ id: 1, ...next })
    .onConflictDoUpdate({ target: settings.id, set: { ...next, updatedAt: new Date() } });
  return changed;
}
