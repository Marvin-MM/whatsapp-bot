'use server';

import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { getEligibility } from '@/lib/autopilot/eligibility';
import { cancelAllScheduled, failedChecksText } from '@/lib/autopilot/mode';
import { runEffects } from '@/lib/ingest/effects';
import { type KillSwitchChange, applyKillSwitch, killSwitchInputSchema } from '@/lib/settings/kill-switches';
import { ownerAction } from './owner-action';

const run = ownerAction({
  name: 'settings.setKillSwitch',
  schema: killSwitchInputSchema,
  handler: async ({ input, tx }) => {
    // Autopilot can be switched ON only while the system-wide checks pass (spec 10.1): the numbers go in the refusal.
    if (input.name === 'autopilot_paused' && input.value === false) {
      const eligibility = await getEligibility(tx);
      if (!eligibility.eligible) throw new ActionRefusal('gate_failed', `Autopilot has not earned its trust yet. ${failedChecksText(eligibility)}`);
    }
    const change = await applyKillSwitch(tx, input);
    // Pausing it stops every countdown that is running.
    const effects = input.name === 'autopilot_paused' && input.value === true ? await cancelAllScheduled(tx) : [];
    return {
      data: change,
      audit: {
        action: 'settings.kill_switch',
        entityType: 'settings',
        entityId: '1',
        metadata: { name: change.name, previous: change.previous, value: change.value },
      },
      afterCommit: () => runEffects(effects),
    };
  },
});

/** Flips ai_paused / sending_paused / autopilot_paused. Owner-only, audited. */
export async function setKillSwitch(input: unknown): Promise<ActionResult<KillSwitchChange>> {
  return run(input);
}
