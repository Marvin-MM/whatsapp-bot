import 'server-only';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { DRAFT_TRIGGER_TYPES } from './trigger';

export interface UnansweredMessage {
  id: string;
  type: string;
  transcription: 'pending' | 'done' | 'failed' | 'low_confidence' | null;
  occurredAt: Date;
}

/**
 * The customer messages nobody has answered yet: live customer messages (not reactions, not deleted, not imported history) that arrived after
 * the latest message the owner's side sent (a reply queued or sent, from the dashboard or from the phone, counts as an answer). This is the
 * set a draft answers, and the set that must be UNCHANGED when a draft is saved: if it changed while the model was thinking, the draft is out of date.
 */
export async function loadUnanswered(db: Db | Tx, conversationId: string): Promise<UnansweredMessage[]> {
  return db
    .select({ id: messages.id, type: messages.type, transcription: messages.transcriptionStatus, occurredAt: messages.occurredAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
        eq(messages.provenance, 'customer'),
        ne(messages.type, 'reaction'),
        inArray(messages.type, [...DRAFT_TRIGGER_TYPES]),
        isNull(messages.deletedAt),
        sql`${messages.occurredAt} > coalesce((SELECT max(o.occurred_at) FROM messages o WHERE o.conversation_id = ${conversationId}::uuid AND o.direction = 'outbound' AND o.status <> 'failed'), '-infinity'::timestamptz)`,
      ),
    )
    .orderBy(asc(messages.occurredAt), asc(messages.id));
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((id) => left.has(id));
}
