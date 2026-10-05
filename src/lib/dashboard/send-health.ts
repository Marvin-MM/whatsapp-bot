import 'server-only';
import { desc, inArray } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { type MessageError, messages } from '@/lib/db/schema';

export interface ProblemMessage {
  messageId: string;
  conversationId: string;
  status: 'queued' | 'unknown' | 'failed';
  error: MessageError | null;
  at: Date;
}

/**
 * Outbound messages that did not simply work: failed, not confirmed, or still queued. The newest 20. Never the text of the message
 * and never a phone number: the owner opens the conversation to see those.
 */
export async function getProblemMessages(db: Db): Promise<ProblemMessage[]> {
  const rows = await db
    .select({ messageId: messages.id, conversationId: messages.conversationId, status: messages.status, error: messages.error, at: messages.occurredAt })
    .from(messages)
    .where(inArray(messages.status, ['queued', 'unknown', 'failed']))
    .orderBy(desc(messages.occurredAt))
    .limit(20);
  return rows.flatMap((row) => (row.status === 'queued' || row.status === 'unknown' || row.status === 'failed' ? [{ ...row, status: row.status }] : []));
}
