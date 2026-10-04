import type { draftStatus } from '@/lib/db/schema';

/**
 * Draft lifecycle (spec section 8). Pure: callers load the current status, ask the machine,
 * and persist the result with a conditional UPDATE so concurrent actors cannot both win.
 *
 *   pending   --approve-->           approved
 *   pending   --approve_edited-->    edited
 *   pending   --reject-->            rejected
 *   pending   --regenerate-->        superseded   (caller creates the new draft)
 *   pending   --schedule-->          scheduled    (autopilot policy passed)
 *   scheduled --approve-->           approved     (owner acts before the timer; see spec 6.5 claim query)
 *   scheduled --approve_edited-->    edited
 *   scheduled --autopilot_send-->    approved     (delay elapsed and recheck passed; actor = autopilot)
 *   scheduled --cancel_scheduled-->  pending      (Cancel in dashboard or Telegram)
 *   scheduled --recheck_failed-->    pending      (reasons recorded by the caller)
 *   scheduled --discard_scheduled--> cancelled    (owner discards the scheduled draft entirely)
 *   pending | scheduled --new_inbound--> superseded
 *   pending | scheduled --fail-->    failed       (generation or validation error)
 *
 * approved, edited, rejected, superseded, cancelled and failed are terminal.
 */

export type DraftStatus = (typeof draftStatus.enumValues)[number];

export type DraftEvent =
  | 'approve'
  | 'approve_edited'
  | 'reject'
  | 'regenerate'
  | 'schedule'
  | 'autopilot_send'
  | 'cancel_scheduled'
  | 'recheck_failed'
  | 'discard_scheduled'
  | 'new_inbound'
  | 'fail';

export const DRAFT_EVENTS: readonly DraftEvent[] = [
  'approve',
  'approve_edited',
  'reject',
  'regenerate',
  'schedule',
  'autopilot_send',
  'cancel_scheduled',
  'recheck_failed',
  'discard_scheduled',
  'new_inbound',
  'fail',
];

/** Exhaustive over DraftStatus: adding an enum value without deciding its transitions fails to compile. */
const TRANSITIONS: Record<DraftStatus, Partial<Record<DraftEvent, DraftStatus>>> = {
  pending: {
    approve: 'approved',
    approve_edited: 'edited',
    reject: 'rejected',
    regenerate: 'superseded',
    schedule: 'scheduled',
    new_inbound: 'superseded',
    fail: 'failed',
  },
  scheduled: {
    // Spec 6.5 claims drafts WHERE status IN ('pending','scheduled'): an explicit owner action beats the
    // autopilot timer. The caller must also remove the delayed autopilot-send job. (Spec 8's diagram omits these arrows.)
    approve: 'approved',
    approve_edited: 'edited',
    autopilot_send: 'approved',
    cancel_scheduled: 'pending',
    recheck_failed: 'pending',
    discard_scheduled: 'cancelled',
    new_inbound: 'superseded',
    fail: 'failed',
  },
  approved: {},
  edited: {},
  rejected: {},
  superseded: {},
  cancelled: {},
  failed: {},
};

export type DraftTransition =
  | { ok: true; from: DraftStatus; to: DraftStatus }
  | { ok: false; from: DraftStatus; event: DraftEvent; reason: 'final_state' | 'invalid_transition' };

export function isFinalDraftStatus(status: DraftStatus): boolean {
  return Object.keys(TRANSITIONS[status]).length === 0;
}

export function transitionDraft(from: DraftStatus, event: DraftEvent): DraftTransition {
  const to = TRANSITIONS[from][event];
  if (to !== undefined) return { ok: true, from, to };
  return { ok: false, from, event, reason: isFinalDraftStatus(from) ? 'final_state' : 'invalid_transition' };
}

export function allowedDraftEvents(from: DraftStatus): DraftEvent[] {
  return DRAFT_EVENTS.filter((event) => TRANSITIONS[from][event] !== undefined);
}

/** Statuses a conditional UPDATE must match for `event` to apply: `WHERE status IN (...)`. */
export function draftStatusesAllowing(event: DraftEvent): DraftStatus[] {
  return (Object.keys(TRANSITIONS) as DraftStatus[]).filter((status) => TRANSITIONS[status][event] !== undefined);
}
