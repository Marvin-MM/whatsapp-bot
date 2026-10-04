import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { conversations } from '@/lib/db/schema';

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationStatus = ConversationRow['status'];

/** The 24-hour customer-service window (spec 6.4). */
export const WINDOW_HOURS = 24;

/** Returns the contact's conversation, creating it on first use. Concurrency-safe: the contact_id unique key decides. */
export async function ensureConversation(tx: Tx, contactId: string, status: ConversationStatus = 'open'): Promise<ConversationRow> {
  await tx.insert(conversations).values({ contactId, status }).onConflictDoNothing({ target: conversations.contactId });
  const [row] = await tx.select().from(conversations).where(eq(conversations.contactId, contactId)).limit(1);
  if (!row) throw new Error('conversation vanished after insert');
  return row;
}

/**
 * Recomputes the conversation's time fields from its messages. THE single place the 24h window is defined:
 *
 *   last_inbound_at   = latest CUSTOMER message (direction inbound, provenance customer), reactions excluded
 *   window_expires_at = last_inbound_at + 24h
 *   last_message_at   = latest message of either side, reactions excluded
 *
 * Echoes (owner replies from the phone) and reactions can therefore never open or extend the window, history sync can
 * never move it backward, and replaying or merging produces the same answer. Deleted-for-everyone messages still count:
 * the customer did write to us inside that window.
 */
export async function refreshConversationAggregates(tx: Tx, conversationId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE conversations SET
      last_inbound_at = agg.last_inbound,
      last_message_at = agg.last_message,
      window_expires_at = agg.last_inbound + make_interval(hours => ${WINDOW_HOURS}),
      updated_at = now()
    FROM (
      SELECT
        max(occurred_at) FILTER (WHERE direction = 'inbound' AND provenance = 'customer' AND type <> 'reaction') AS last_inbound,
        max(occurred_at) FILTER (WHERE type <> 'reaction') AS last_message
      FROM messages
      WHERE conversation_id = ${conversationId}
    ) AS agg
    WHERE conversations.id = ${conversationId}
  `);
}

export async function setConversationStatus(tx: Tx, conversationId: string, status: ConversationStatus): Promise<void> {
  await tx.update(conversations).set({ status, updatedAt: new Date() }).where(eq(conversations.id, conversationId));
}
