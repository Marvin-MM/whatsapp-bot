import 'server-only';
import { eq } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { type MessageError, messages } from '@/lib/db/schema';
import { transitionMessage, type WebhookStatus as MachineStatus } from '@/lib/state/message-machine';
import { describeFailureCode } from '@/lib/whatsapp/errors';
import type { WebhookStatus } from '@/lib/whatsapp/webhook-schema';
import type { Effect } from './effects';

export type StatusOutcome = 'applied' | 'noop' | 'unknown_message' | 'ignored';

/** `played` (a voice note was listened to) is a kind of read. Anything else Meta may add is ignored, not guessed at. */
const KNOWN: Readonly<Record<string, MachineStatus>> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  played: 'read',
  failed: 'failed',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failureOf(status: WebhookStatus): MessageError {
  const first = status.errors?.[0];
  return {
    kind: 'permanent',
    code: first?.code === undefined ? null : String(first.code),
    message: describeFailureCode(first?.code, first?.title ?? first?.message).slice(0, 300),
  };
}

/**
 * Applies one delivery status to an outbound message. The message is found by its wamid; when we do not hold that wamid
 * yet (the status beat our own write of it) the `biz_opaque_callback_data` we sent, our own message id, finds it and the
 * wamid is recorded from the status. The state machine decides what changes: a stale or replayed status is a no-op, and
 * a status never moves a message backward.
 *
 * `unknown_message` means the message is not in our database (yet). Live statuses retry, because the row may just not
 * have been committed; history statuses give up silently.
 */
export async function applyStatus(tx: Tx, status: WebhookStatus): Promise<{ outcome: StatusOutcome; effects: Effect[] }> {
  const event = Object.hasOwn(KNOWN, status.status) ? KNOWN[status.status] : undefined;
  if (event === undefined) return { outcome: 'ignored', effects: [] };

  let [row] = await tx.select().from(messages).where(eq(messages.wamid, status.id)).limit(1).for('update');
  let adoptWamid = false;
  if (!row && status.biz_opaque_callback_data && UUID.test(status.biz_opaque_callback_data)) {
    [row] = await tx.select().from(messages).where(eq(messages.id, status.biz_opaque_callback_data)).limit(1).for('update');
    if (row && row.direction === 'outbound' && row.wamid === null) adoptWamid = true;
    // A callback id that points at a message with a DIFFERENT wamid is not this message: do not touch it.
    else if (row) row = undefined;
  }
  if (!row) return { outcome: 'unknown_message', effects: [] };
  if (row.direction !== 'outbound') return { outcome: 'ignored', effects: [] };

  const transition = transitionMessage(row.status, { type: 'webhook', status: event });
  if (!transition.ok) return { outcome: 'ignored', effects: [] };

  const patch: Partial<typeof messages.$inferInsert> = {};
  if (adoptWamid) patch.wamid = status.id;
  if (transition.changed) {
    patch.status = transition.to;
    if (transition.to === 'failed') patch.error = failureOf(status);
  }
  if (Object.keys(patch).length === 0) return { outcome: 'noop', effects: [] };
  await tx.update(messages).set(patch).where(eq(messages.id, row.id));

  if (!transition.changed) return { outcome: 'noop', effects: [] };
  return {
    outcome: 'applied',
    effects: [{ type: 'publish', event: { type: 'message:status', payload: { conversationId: row.conversationId, messageId: row.id, status: transition.to } } }],
  };
}
