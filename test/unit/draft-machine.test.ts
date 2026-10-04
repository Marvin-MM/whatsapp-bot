import { describe, expect, it } from 'vitest';
import { draftStatus } from '@/lib/db/schema';
import {
  DRAFT_EVENTS,
  type DraftEvent,
  type DraftStatus,
  allowedDraftEvents,
  draftStatusesAllowing,
  isFinalDraftStatus,
  transitionDraft,
} from '@/lib/state/draft-machine';

/**
 * The allowed set, written out from the spec (section 8 diagram + the 6.5 claim query) rather than
 * derived from the implementation, so the test can disagree with it. Everything not listed must be refused.
 */
const ALLOWED: ReadonlyArray<readonly [DraftStatus, DraftEvent, DraftStatus]> = [
  ['pending', 'approve', 'approved'],
  ['pending', 'approve_edited', 'edited'],
  ['pending', 'reject', 'rejected'],
  ['pending', 'regenerate', 'superseded'],
  ['pending', 'schedule', 'scheduled'],
  ['pending', 'new_inbound', 'superseded'],
  ['pending', 'fail', 'failed'],
  ['scheduled', 'approve', 'approved'],
  ['scheduled', 'approve_edited', 'edited'],
  ['scheduled', 'autopilot_send', 'approved'],
  ['scheduled', 'cancel_scheduled', 'pending'],
  ['scheduled', 'recheck_failed', 'pending'],
  ['scheduled', 'discard_scheduled', 'cancelled'],
  ['scheduled', 'new_inbound', 'superseded'],
  ['scheduled', 'fail', 'failed'],
];

const TERMINAL: DraftStatus[] = ['approved', 'edited', 'rejected', 'superseded', 'cancelled', 'failed'];
const STATUSES = draftStatus.enumValues;

const isAllowed = (from: DraftStatus, event: DraftEvent) => ALLOWED.some(([f, e]) => f === from && e === event);

describe('draft state machine', () => {
  it.each(ALLOWED)('allows %s --%s--> %s', (from, event, to) => {
    expect(transitionDraft(from, event)).toEqual({ ok: true, from, to });
  });

  it('refuses every (status, event) pair that is not in the allowed set', () => {
    let refused = 0;
    for (const from of STATUSES) {
      for (const event of DRAFT_EVENTS) {
        if (isAllowed(from, event)) continue;
        const result = transitionDraft(from, event);
        expect(result.ok, `${from} --${event}--> should be refused`).toBe(false);
        refused += 1;
      }
    }
    // 8 statuses x 11 events = 88 pairs, 15 allowed.
    expect(refused).toBe(STATUSES.length * DRAFT_EVENTS.length - ALLOWED.length);
  });

  it('knows every status in the database enum (no status is silently unhandled)', () => {
    for (const status of STATUSES) {
      expect(() => transitionDraft(status, 'approve')).not.toThrow();
    }
    expect([...STATUSES].sort()).toEqual(
      ['pending', 'scheduled', 'approved', 'edited', 'rejected', 'superseded', 'cancelled', 'failed'].sort(),
    );
  });

  describe('terminal states', () => {
    it.each(TERMINAL)('%s accepts no event, so a decided draft can never be resurrected', (status) => {
      expect(isFinalDraftStatus(status)).toBe(true);
      expect(allowedDraftEvents(status)).toEqual([]);
      for (const event of DRAFT_EVENTS) {
        expect(transitionDraft(status, event)).toEqual({ ok: false, from: status, event, reason: 'final_state' });
      }
    });

    it('pending and scheduled are not terminal and report invalid_transition for bad events', () => {
      expect(isFinalDraftStatus('pending')).toBe(false);
      expect(isFinalDraftStatus('scheduled')).toBe(false);
      expect(transitionDraft('pending', 'autopilot_send')).toMatchObject({ ok: false, reason: 'invalid_transition' });
      expect(transitionDraft('scheduled', 'reject')).toMatchObject({ ok: false, reason: 'invalid_transition' });
    });
  });

  describe('autopilot safety', () => {
    it('a draft can only be auto-sent from scheduled, never straight from pending', () => {
      expect(transitionDraft('pending', 'autopilot_send').ok).toBe(false);
      expect(draftStatusesAllowing('autopilot_send')).toEqual(['scheduled']);
    });

    it('only pending drafts can be scheduled, so policy runs before any scheduling', () => {
      expect(draftStatusesAllowing('schedule')).toEqual(['pending']);
    });

    it('a new inbound message supersedes both pending and scheduled drafts', () => {
      expect(draftStatusesAllowing('new_inbound').sort()).toEqual(['pending', 'scheduled']);
    });

    it('cancel and failed recheck both return a scheduled draft to pending for owner review', () => {
      expect(transitionDraft('scheduled', 'cancel_scheduled')).toMatchObject({ ok: true, to: 'pending' });
      expect(transitionDraft('scheduled', 'recheck_failed')).toMatchObject({ ok: true, to: 'pending' });
    });

    it('an owner action on a scheduled draft is allowed and claims it (6.5), matching the claim query', () => {
      expect(draftStatusesAllowing('approve').sort()).toEqual(['pending', 'scheduled']);
      expect(draftStatusesAllowing('approve_edited').sort()).toEqual(['pending', 'scheduled']);
    });

    it('cancelled is reachable only by discarding a scheduled draft', () => {
      const into = STATUSES.flatMap((from) => DRAFT_EVENTS.flatMap((event) => {
        const result = transitionDraft(from, event);
        return result.ok && result.to === 'cancelled' ? [`${from}:${event}`] : [];
      }));
      expect(into).toEqual(['scheduled:discard_scheduled']);
    });
  });

  it('walks the documented autopilot lifecycle end to end', () => {
    let status: DraftStatus = 'pending';
    for (const [event, expected] of [
      ['schedule', 'scheduled'],
      ['cancel_scheduled', 'pending'],
      ['schedule', 'scheduled'],
      ['autopilot_send', 'approved'],
    ] as const) {
      const result = transitionDraft(status, event);
      expect(result.ok).toBe(true);
      if (result.ok) status = result.to;
      expect(status).toBe(expected);
    }
  });

  it('draftStatusesAllowing is the exact WHERE clause set for each conditional UPDATE', () => {
    for (const event of DRAFT_EVENTS) {
      const expected = ALLOWED.filter(([, e]) => e === event).map(([from]) => from).sort();
      expect(draftStatusesAllowing(event).sort()).toEqual(expected);
    }
  });
});
