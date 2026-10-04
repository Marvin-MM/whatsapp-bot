import 'server-only';
import { z } from 'zod';
import type { Tx } from '@/lib/db';
import { settings } from '@/lib/db/schema';

/** Kill switches stop a category of activity immediately (spec glossary). */
export const KILL_SWITCHES = ['ai_paused', 'sending_paused', 'autopilot_paused'] as const;

export const killSwitchInputSchema = z.object({
  name: z.enum(KILL_SWITCHES),
  value: z.boolean(),
});

export type KillSwitchInput = z.infer<typeof killSwitchInputSchema>;

export interface KillSwitchChange {
  name: KillSwitchInput['name'];
  previous: boolean;
  value: boolean;
}

const COLUMN_DEFAULTS: Record<KillSwitchInput['name'], boolean> = {
  ai_paused: false,
  sending_paused: false,
  autopilot_paused: true,
};

function patch(name: KillSwitchInput['name'], value: boolean): Partial<typeof settings.$inferInsert> {
  switch (name) {
    case 'ai_paused':
      return { aiPaused: value };
    case 'sending_paused':
      return { sendingPaused: value };
    case 'autopilot_paused':
      return { autopilotPaused: value };
  }
}

function read(row: typeof settings.$inferSelect | undefined, name: KillSwitchInput['name']): boolean {
  if (!row) return COLUMN_DEFAULTS[name];
  switch (name) {
    case 'ai_paused':
      return row.aiPaused;
    case 'sending_paused':
      return row.sendingPaused;
    case 'autopilot_paused':
      return row.autopilotPaused;
  }
}

/** Sets one kill switch on the singleton settings row (created on first use). */
export async function applyKillSwitch(tx: Tx, input: KillSwitchInput): Promise<KillSwitchChange> {
  const [before] = await tx.select().from(settings).limit(1);
  const previous = read(before, input.name);
  await tx
    .insert(settings)
    .values({ id: 1, ...patch(input.name, input.value) })
    .onConflictDoUpdate({ target: settings.id, set: { ...patch(input.name, input.value), updatedAt: new Date() } });
  return { name: input.name, previous, value: input.value };
}
