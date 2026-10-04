import { describe, expect, it } from 'vitest';
import { messageStatus } from '@/lib/db/schema';
import {
  DELIVERY_RANK,
  type MessageEvent,
  type MessageStatus,
  type WebhookStatus,
  isProblemStatus,
  transitionMessage,
} from '@/lib/state/message-machine';

const STATUSES = messageStatus.enumValues;
const WEBHOOKS: WebhookStatus[] = ['sent', 'delivered', 'read', 'failed'];
const webhook = (status: WebhookStatus): MessageEvent => ({ type: 'webhook', status });

/** Applies an event and returns the new status, throwing if the transition is refused. */
function apply(from: MessageStatus, event: MessageEvent): MessageStatus {
  const result = transitionMessage(from, event);
  if (!result.ok) throw new Error(`${from} --${event.type}--> refused`);
  return result.to;
}

describe('outbound message state machine: sending side', () => {
  it('queued --api_accepted--> sent', () => {
    expect(transitionMessage('queued', { type: 'api_accepted' })).toEqual({ ok: true, from: 'queued', to: 'sent', changed: true });
  });

  it('queued --permanent_error--> failed', () => {
    expect(apply('queued', { type: 'permanent_error' })).toBe('failed');
  });

  it('queued --ambiguous_error--> unknown (the message may have reached Meta; never retried)', () => {
    expect(apply('queued', { type: 'ambiguous_error' })).toBe('unknown');
  });

  it('unknown --owner_mark_sent--> sent, unknown --owner_resend--> failed (a new row carries the resend)', () => {
    expect(apply('unknown', { type: 'owner_mark_sent' })).toBe('sent');
    expect(apply('unknown', { type: 'owner_resend' })).toBe('failed');
  });

  it('send-side events are refused from every status except their single legal source', () => {
    const legal: Record<string, MessageStatus> = {
      api_accepted: 'queued',
      permanent_error: 'queued',
      ambiguous_error: 'queued',
      owner_mark_sent: 'unknown',
      owner_resend: 'unknown',
    };
    for (const [type, source] of Object.entries(legal)) {
      for (const from of STATUSES) {
        const result = transitionMessage(from, { type } as MessageEvent);
        expect(result.ok, `${from} --${type}--> expected ${from === source ? 'ok' : 'refused'}`).toBe(from === source);
      }
    }
  });

  it('an unknown message can never be auto-retried back to queued', () => {
    for (const event of [{ type: 'api_accepted' }, { type: 'permanent_error' }, { type: 'ambiguous_error' }] as const) {
      expect(transitionMessage('unknown', event).ok).toBe(false);
    }
  });
});

describe('outbound message state machine: status webhooks', () => {
  it('moves forward along sent -> delivered -> read', () => {
    expect(apply('queued', webhook('sent'))).toBe('sent');
    expect(apply('sent', webhook('delivered'))).toBe('delivered');
    expect(apply('delivered', webhook('read'))).toBe('read');
  });

  it('can skip steps when a webhook is lost or reordered (sent -> read, queued -> delivered)', () => {
    expect(apply('sent', webhook('read'))).toBe('read');
    expect(apply('queued', webhook('delivered'))).toBe('delivered');
  });

  it('never moves backward: late "sent"/"delivered" webhooks are successful no-ops', () => {
    for (const [from, late] of [
      ['read', 'delivered'],
      ['read', 'sent'],
      ['delivered', 'sent'],
      ['delivered', 'delivered'],
      ['sent', 'sent'],
      ['read', 'read'],
    ] as const) {
      expect(transitionMessage(from, webhook(late)), `${from} + late ${late}`).toEqual({ ok: true, from, to: from, changed: false });
    }
  });

  it('failed webhook: sent/delivered/queued/unknown -> failed', () => {
    for (const from of ['queued', 'sent', 'delivered', 'unknown'] as const) {
      expect(apply(from, webhook('failed'))).toBe('failed');
    }
  });

  it('read is final: a late failed webhook cannot demote it', () => {
    expect(transitionMessage('read', webhook('failed'))).toEqual({ ok: true, from: 'read', to: 'read', changed: false });
  });

  it('failed is terminal: no later progress webhook revives it', () => {
    for (const late of WEBHOOKS) {
      expect(transitionMessage('failed', webhook(late))).toEqual({ ok: true, from: 'failed', to: 'failed', changed: false });
    }
  });

  it('a progress webhook that matches an unknown message proves it was sent', () => {
    expect(apply('unknown', webhook('sent'))).toBe('sent');
    expect(apply('unknown', webhook('delivered'))).toBe('delivered');
  });

  it('inbound (received) messages accept no delivery statuses', () => {
    for (const status of WEBHOOKS) {
      expect(transitionMessage('received', webhook(status)).ok).toBe(false);
    }
  });

  it('replaying the same webhook is idempotent', () => {
    for (const from of STATUSES) {
      for (const status of WEBHOOKS) {
        const first = transitionMessage(from, webhook(status));
        if (!first.ok) continue;
        const second = transitionMessage(first.to, webhook(status));
        expect(second.ok && second.to === first.to && !second.changed, `${from} +${status} twice`).toBe(true);
      }
    }
  });

  it('delivery rank never decreases under any ordering of up to 4 webhooks (exhaustive)', () => {
    const rank = (status: MessageStatus): number => (status in DELIVERY_RANK ? DELIVERY_RANK[status as keyof typeof DELIVERY_RANK] : -1);
    const sequences: WebhookStatus[][] = [[]];
    for (let length = 1; length <= 4; length += 1) {
      const prior = sequences.filter((sequence) => sequence.length === length - 1);
      for (const sequence of prior) for (const status of WEBHOOKS) sequences.push([...sequence, status]);
    }
    expect(sequences.length).toBe(1 + 4 + 16 + 64 + 256);

    for (const sequence of sequences) {
      let status: MessageStatus = 'queued';
      for (const next of sequence) {
        const before = status;
        status = apply(status, webhook(next));
        if (before === 'failed') expect(status, `failed must stay failed in ${sequence.join(',')}`).toBe('failed');
        else if (status !== 'failed') expect(rank(status), `${sequence.join(',')}`).toBeGreaterThanOrEqual(rank(before));
      }
    }
  });
});

describe('problem statuses', () => {
  it('flags queued, unknown and failed for the problems panel only', () => {
    expect(STATUSES.filter(isProblemStatus).sort()).toEqual(['failed', 'queued', 'unknown']);
  });
});
