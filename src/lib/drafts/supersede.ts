import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { drafts } from '@/lib/db/schema';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';

/**
 * Supersedes every open draft of a conversation (`pending` or `scheduled`) and returns their ids.
 *
 * Used when something makes the draft obsolete: a new customer message, or the owner answering from the phone (an echo).
 * The statuses to match come from the draft state machine (`new_inbound`), never from a literal list, so the machine
 * stays the single authority. The UPDATE is conditional on the status, so a draft the owner approved a millisecond
 * earlier is left alone and the caller is told only about the rows that really changed.
 *
 * Callers that hold delayed autopilot jobs for these drafts must remove them after commit (Phase 7).
 */
export async function supersedeOpenDrafts(tx: Tx, conversationId: string): Promise<string[]> {
  const rows = await tx
    .update(drafts)
    .set({ status: 'superseded' })
    .where(and(eq(drafts.conversationId, conversationId), inArray(drafts.status, draftStatusesAllowing('new_inbound'))))
    .returning({ id: drafts.id });
  return rows.map((row) => row.id);
}

/**
 * Supersedes the open drafts that were written in answer to `messageId`: when the customer edits or deletes that message
 * the draft no longer matches what they said. Drafts that answered other messages are untouched.
 */
export async function supersedeDraftsTriggeredBy(tx: Tx, conversationId: string, messageId: string): Promise<string[]> {
  const rows = await tx
    .update(drafts)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(drafts.conversationId, conversationId),
        inArray(drafts.status, draftStatusesAllowing('new_inbound')),
        sql`${messageId}::uuid = ANY(${drafts.triggerMessageIds})`,
      ),
    )
    .returning({ id: drafts.id });
  return rows.map((row) => row.id);
}
