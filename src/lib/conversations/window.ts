/**
 * The 24-hour customer-service window, as the UI and (from Phase 2) the send path's pre-check see it. There is exactly one
 * definition of "is it open": `isWindowOpen`. Free-form messages may be sent only while it is; outside it only approved
 * templates may. The window itself (`window_expires_at`) is maintained in one place, `refreshConversationAggregates`.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Closing within this long raises the "expiring soon" treatment (and, in Phase 5, an alert). */
export const EXPIRING_SOON_MS = 2 * HOUR;

export type WindowState =
  /** The customer has never written: there is no window, so only a template can start the conversation. */
  | { kind: 'none' }
  | { kind: 'open' | 'expiring'; expiresAt: Date; remainingMs: number }
  | { kind: 'closed'; expiresAt: Date; remainingMs: 0 };

/** True while a free-form message may still be sent. The instant the window expires it is closed. */
export function isWindowOpen(expiresAt: Date | null | undefined, now: Date): boolean {
  return expiresAt !== null && expiresAt !== undefined && now.getTime() < expiresAt.getTime();
}

export function windowState(expiresAt: Date | null | undefined, now: Date): WindowState {
  if (expiresAt === null || expiresAt === undefined) return { kind: 'none' };
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) return { kind: 'closed', expiresAt, remainingMs: 0 };
  return { kind: remainingMs < EXPIRING_SOON_MS ? 'expiring' : 'open', expiresAt, remainingMs };
}

/** "3h 20m", "45m", "under a minute". Rounds down: a countdown must never promise more time than there is. */
export function formatRemaining(ms: number): string {
  if (ms < MINUTE) return 'under a minute';
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** The short badge text and the longer explanation for each state. Plain words: this decides what the owner may send. */
export function describeWindow(state: WindowState): { label: string; detail: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  switch (state.kind) {
    case 'none':
      return { label: 'No window', detail: 'This customer has not messaged yet, so only an approved template can be sent.', tone: 'neutral' };
    case 'open':
      return { label: `Open · ${formatRemaining(state.remainingMs)} left`, detail: 'You can send a normal message.', tone: 'success' };
    case 'expiring':
      return { label: `Closes in ${formatRemaining(state.remainingMs)}`, detail: 'Reply soon: after this only an approved template can be sent.', tone: 'warning' };
    case 'closed':
      return { label: 'Closed · templates only', detail: 'More than 24 hours since the customer last wrote. Only an approved template can be sent.', tone: 'danger' };
  }
}
