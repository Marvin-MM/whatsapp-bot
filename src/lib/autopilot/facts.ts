import 'server-only';
import { eq, sql } from 'drizzle-orm';
import type { DraftIntent } from '@/lib/ai/schemas';
import { ELIGIBLE_OWNER_PROVENANCE } from '@/lib/ai/fewshot-sql';
import type { DbOrTx } from '@/lib/db';
import { contacts, conversations, drafts, settings } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { quietHoursSchema } from '@/lib/notify/quiet-hours';
import { getEligibility } from './eligibility';
import type { PolicyInput } from './policy';

/**
 * Everything the pure policy needs to know about one draft, read from the database. Used twice: after the draft is written (decide whether to
 * schedule it) and again just before it would be sent (the state may have changed during the delay). It reads; it never writes.
 */

export interface DraftFacts {
  draft: typeof drafts.$inferSelect;
  conversationId: string;
  contact: { displayName: string | null; username: string | null; phoneE164: string | null; bsuid: string | null };
  settings: typeof settings.$inferSelect;
  input: PolicyInput;
}

const provenanceList = sql.join(ELIGIBLE_OWNER_PROVENANCE.map((value) => sql`${value}`), sql`, `);

export async function loadDraftFacts(db: DbOrTx, draftId: string, now: Date): Promise<DraftFacts | null> {
  const [row] = await db
    .select({ draft: drafts, conversation: conversations, contact: contacts })
    .from(drafts)
    .innerJoin(conversations, eq(conversations.id, drafts.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(drafts.id, draftId))
    .limit(1);
  if (!row) return null;
  const [setting] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);
  if (!setting) return null;
  const conversationId = row.conversation.id;
  const timeZone = getEnv().OWNER_TIMEZONE;
  const triggers = row.draft.triggerMessageIds.length === 0 ? sql`NULL::uuid` : sql.join(row.draft.triggerMessageIds.map((id) => sql`${id}::uuid`), sql`, `);

  const [counts] = await db.execute<{ owner_messages: number; conversation_hour: number; today: number; transcript: boolean }>(sql`
    SELECT
      (SELECT count(*)::int FROM messages WHERE conversation_id = ${conversationId}::uuid AND direction = 'outbound' AND status <> 'failed' AND provenance IN (${provenanceList})) AS owner_messages,
      (SELECT count(*)::int FROM messages WHERE conversation_id = ${conversationId}::uuid AND direction = 'outbound' AND provenance = 'ai_autopilot' AND status <> 'failed'
         AND occurred_at > ${now.toISOString()}::timestamptz - interval '1 hour') AS conversation_hour,
      (SELECT count(*)::int FROM messages WHERE direction = 'outbound' AND provenance = 'ai_autopilot' AND status <> 'failed'
         AND occurred_at >= (date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone})) AS today,
      coalesce((SELECT bool_or(content_source = 'transcript' OR type = 'audio') FROM messages WHERE id IN (${triggers})), false) AS transcript
  `);

  // For the customer's last three messages, newest first: how long after OUR previous message each one arrived (null: we had not written yet).
  const gaps = await db.execute<{ gap: number | null }>(sql`
    SELECT extract(epoch FROM (m.occurred_at - prev.occurred_at))::float8 AS gap
    FROM (
      SELECT id, occurred_at FROM messages
      WHERE conversation_id = ${conversationId}::uuid AND direction = 'inbound' AND provenance = 'customer' AND type <> 'reaction' AND deleted_at IS NULL
      ORDER BY occurred_at DESC, id DESC LIMIT 3
    ) m
    LEFT JOIN LATERAL (
      SELECT o.occurred_at FROM messages o
      WHERE o.conversation_id = ${conversationId}::uuid AND o.direction = 'outbound' AND o.status <> 'failed' AND o.occurred_at < m.occurred_at
      ORDER BY o.occurred_at DESC LIMIT 1
    ) prev ON true
    ORDER BY m.occurred_at DESC, m.id DESC
  `);

  const eligibility = await getEligibility(db, now);
  const quiet = quietHoursSchema.safeParse(setting.quietHours);

  const input: PolicyInput = {
    now,
    timeZone,
    conversation: {
      replyMode: row.conversation.replyMode,
      autopilotUntil: row.conversation.autopilotUntil,
      windowExpiresAt: row.conversation.windowExpiresAt,
      consecutiveAutoReplies: row.conversation.consecutiveAutoReplies,
      ownerMessageCount: counts?.owner_messages ?? 0,
    },
    draft: {
      content: row.draft.content,
      intent: row.draft.intent as DraftIntent,
      riskFlags: row.draft.riskFlags,
      missingFacts: row.draft.missingFacts,
      noReplyNeeded: row.draft.noReplyNeeded,
      answersTranscript: counts?.transcript ?? false,
    },
    settings: {
      autopilotPaused: setting.autopilotPaused,
      allowedIntents: setting.autopilotAllowedIntents,
      maxPerConversationPerHour: setting.autopilotMaxPerConversationPerHour,
      maxPerDay: setting.autopilotMaxPerDay,
      maxConsecutive: setting.autopilotMaxConsecutive,
      quietHours: quiet.success ? quiet.data : null,
    },
    gateEligible: eligibility.eligible,
    usage: { conversationLastHour: counts?.conversation_hour ?? 0, today: counts?.today ?? 0 },
    recentCustomerGapsSeconds: gaps.map((row) => row.gap),
  };
  return { draft: row.draft, conversationId, contact: row.contact, settings: setting, input };
}

/** True when this draft's conversation currently has an autopilot message that went out (or is going out) in the last 24 hours: the disclosure is already on it. */
export async function disclosedWithin24h(db: DbOrTx, conversationId: string, now: Date): Promise<boolean> {
  const [row] = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM messages WHERE conversation_id = ${conversationId}::uuid AND direction = 'outbound' AND provenance = 'ai_autopilot' AND status <> 'failed'
        AND occurred_at > ${now.toISOString()}::timestamptz - interval '24 hours'
    ) AS found`);
  return row?.found ?? false;
}

