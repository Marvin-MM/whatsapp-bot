import { Badge } from '@/components/ui/badge';
import type { ShellState } from '@/lib/dashboard/shell-state';

/** Always-visible state of the three kill switches: the owner must never wonder whether the bot can act. */
// Compact on phones so the badges, alert counter and sign-out fit on one header row.
const COMPACT = 'px-2 text-[11px] sm:px-2.5 sm:text-xs';

export function KillSwitchBadges({ state }: { state: Pick<ShellState, 'aiPaused' | 'sendingPaused' | 'autopilotPaused'> }) {
  return (
    <ul aria-label="Kill switches" className="flex items-center gap-1 sm:gap-1.5">
      <li>
        <Badge className={COMPACT} variant={state.aiPaused ? 'warning' : 'success'}>
          {state.aiPaused ? 'AI paused' : 'AI on'}
        </Badge>
      </li>
      <li>
        <Badge className={COMPACT} variant={state.sendingPaused ? 'danger' : 'success'}>
          {state.sendingPaused ? 'Sending paused' : 'Sending on'}
        </Badge>
      </li>
      <li>
        <Badge className={COMPACT} variant={state.autopilotPaused ? 'neutral' : 'info'}>
          {state.autopilotPaused ? 'Autopilot off' : 'Autopilot on'}
        </Badge>
      </li>
    </ul>
  );
}
