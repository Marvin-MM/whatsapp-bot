'use server';

import { type ActionResult } from '@/lib/actions/owner-action-core';
import { type KillSwitchChange, applyKillSwitch, killSwitchInputSchema } from '@/lib/settings/kill-switches';
import { ownerAction } from './owner-action';

const run = ownerAction({
  name: 'settings.setKillSwitch',
  schema: killSwitchInputSchema,
  handler: async ({ input, tx }) => {
    const change = await applyKillSwitch(tx, input);
    return {
      data: change,
      audit: {
        action: 'settings.kill_switch',
        entityType: 'settings',
        entityId: '1',
        metadata: { name: change.name, previous: change.previous, value: change.value },
      },
    };
  },
});

/** Flips ai_paused / sending_paused / autopilot_paused. Owner-only, audited. */
export async function setKillSwitch(input: unknown): Promise<ActionResult<KillSwitchChange>> {
  return run(input);
}
