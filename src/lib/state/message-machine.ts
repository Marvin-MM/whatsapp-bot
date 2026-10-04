import type { messageStatus } from '@/lib/db/schema';

/**
 * Outbound message lifecycle (spec section 8).
 *
 *   queued --api_accepted--> sent --webhook delivered--> delivered --webhook read--> read
 *   queued --permanent_error--> failed
 *   queued --ambiguous_error--> unknown
 *   unknown --owner_mark_sent--> sent
 *   unknown --owner_resend--> failed        (the caller creates a NEW queued row; this one is closed)
 *   queued | sent | delivered | unknown --webhook failed--> failed
 *
 * Status webhooks arrive out of order and are replayed. A status never moves backward
 * (read beats delivered beats sent): a stale or duplicate webhook is a successful no-op
 * (`changed: false`), not an error. `failed` and `read` are terminal.
 * `received` is the inbound-only status and has no transitions.
 */

export type MessageStatus = (typeof messageStatus.enumValues)[number];

export type WebhookStatus = 'sent' | 'delivered' | 'read' | 'failed';

export type MessageEvent =
  | { type: 'api_accepted' }
  | { type: 'permanent_error' }
  | { type: 'ambiguous_error' }
  | { type: 'webhook'; status: WebhookStatus }
  | { type: 'owner_mark_sent' }
  | { type: 'owner_resend' };

export type MessageTransition =
  | { ok: true; from: MessageStatus; to: MessageStatus; changed: boolean }
  | { ok: false; from: MessageStatus; event: MessageEvent['type']; reason: 'invalid_transition' };

/** Forward progress of delivery. `failed` is terminal and sits outside the ladder. */
export const DELIVERY_RANK = { queued: 0, sent: 1, delivered: 2, read: 3 } as const;

type Ranked = keyof typeof DELIVERY_RANK;

function isRanked(status: MessageStatus): status is Ranked {
  return status in DELIVERY_RANK;
}

const accept = (from: MessageStatus, to: MessageStatus): MessageTransition => ({ ok: true, from, to, changed: from !== to });
const reject = (from: MessageStatus, event: MessageEvent['type']): MessageTransition => ({
  ok: false,
  from,
  event,
  reason: 'invalid_transition',
});

export function transitionMessage(from: MessageStatus, event: MessageEvent): MessageTransition {
  switch (event.type) {
    case 'api_accepted':
      return from === 'queued' ? accept(from, 'sent') : reject(from, event.type);
    case 'permanent_error':
      return from === 'queued' ? accept(from, 'failed') : reject(from, event.type);
    case 'ambiguous_error':
      return from === 'queued' ? accept(from, 'unknown') : reject(from, event.type);
    case 'owner_mark_sent':
      return from === 'unknown' ? accept(from, 'sent') : reject(from, event.type);
    case 'owner_resend':
      return from === 'unknown' ? accept(from, 'failed') : reject(from, event.type);
    case 'webhook':
      return applyWebhook(from, event.status);
  }
}

function applyWebhook(from: MessageStatus, status: WebhookStatus): MessageTransition {
  // Inbound messages never receive delivery statuses.
  if (from === 'received') return reject(from, 'webhook');

  if (status === 'failed') {
    // `read` proves delivery; a later failure report is stale. `failed` is already terminal.
    if (from === 'read' || from === 'failed') return accept(from, from);
    return accept(from, 'failed');
  }

  // A failed message stays failed whatever late progress webhook arrives.
  if (from === 'failed') return accept(from, 'failed');
  // `unknown` is not on the ladder: a matched progress webhook proves the send happened.
  if (from === 'unknown') return accept(from, status);
  if (!isRanked(from)) return reject(from, 'webhook');

  return DELIVERY_RANK[status] > DELIVERY_RANK[from] ? accept(from, status) : accept(from, from);
}

/** Statuses that still need attention in the problems panel. */
export function isProblemStatus(status: MessageStatus): boolean {
  return status === 'queued' || status === 'unknown' || status === 'failed';
}
