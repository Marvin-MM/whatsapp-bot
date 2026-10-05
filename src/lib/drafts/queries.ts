import 'server-only';
import { sql } from 'drizzle-orm';
import { displayName, secondaryLine } from '@/lib/conversations/display';
import { oneLine, toDate } from '@/lib/conversations/queries';
import type { Db } from '@/lib/db';
import { isDraftStale } from '@/lib/send/send-message';

export type QueueStatus = 'pending' | 'scheduled' | 'failed';

export interface QueueItem {
  id: string;
  status: QueueStatus;
  createdAt: Date;
  intent: string;
  noReplyNeeded: boolean;
  conversationId: string;
  name: string;
  /** The customer's first unanswered message, on one line. */
  preview: string;
}

interface QueueRow extends Record<string, unknown> {
  id: string;
  status: QueueStatus;
  created_at: string | Date;
  intent: string;
  no_reply_needed: boolean;
  conversation_id: string;
  display_name: string | null;
  username: string | null;
  phone_e164: string | null;
  bsuid: string | null;
  preview: string | null;
}

/**
 * What needs the owner's decision, oldest first (spec 12): drafts waiting for approval, plus drafts that FAILED for a customer who is still
 * unanswered (so the page can offer "Regenerate" and the owner never wonders why a customer has no draft).
 */
export async function listApprovalQueue(db: Db): Promise<QueueItem[]> {
  const rows = await db.execute<QueueRow>(sql`
    SELECT d.id, d.status, d.created_at, d.intent, d.no_reply_needed, d.conversation_id,
           ct.display_name, ct.username, ct.phone_e164, ct.bsuid,
           (SELECT m.content FROM messages m WHERE m.id = d.trigger_message_ids[1]) AS preview
    FROM drafts d
    JOIN conversations c ON c.id = d.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE d.status IN ('pending', 'scheduled')
       OR (d.status = 'failed'
           AND c.status = 'waiting_on_me'
           AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.conversation_id = d.conversation_id AND o.direction = 'outbound' AND o.status <> 'failed' AND o.occurred_at > d.created_at)
           AND NOT EXISTS (SELECT 1 FROM drafts n WHERE n.conversation_id = d.conversation_id AND n.created_at > d.created_at AND n.status IN ('pending', 'scheduled')))
    ORDER BY d.created_at, d.id
    LIMIT 200
  `);
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: toDate(row.created_at),
    intent: row.intent,
    noReplyNeeded: row.no_reply_needed,
    conversationId: row.conversation_id,
    name: displayName({ displayName: row.display_name, username: row.username, phoneE164: row.phone_e164, bsuid: row.bsuid }),
    preview: oneLine(row.preview ?? '', 80),
  }));
}

/** Drafts waiting for a decision: the same set the approvals queue opens with (a "needs no reply" draft still waits for a dismiss), so the badge never disagrees with the page. */
export async function countOpenDrafts(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drafts WHERE status IN ('pending', 'scheduled')`);
  return rows[0]?.n ?? 0;
}

/** Drafts the autopilot has decided to send and is counting down: they go out by themselves unless the owner cancels them. */
export async function countScheduledDrafts(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drafts WHERE status = 'scheduled'`);
  return rows[0]?.n ?? 0;
}

/** The conversation's open draft, if any (the thread links to it instead of offering to make another). Newest wins. */
export async function getOpenDraftId(db: Db, conversationId: string): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM drafts WHERE conversation_id = ${conversationId}::uuid AND status IN ('pending', 'scheduled') ORDER BY created_at DESC, id DESC LIMIT 1
  `);
  return rows[0]?.id ?? null;
}

export interface IntentStats {
  /** Drafts of this intent the owner sent (approved as written or edited), last 90 days. */
  sent: number;
  edited: number;
  medianEditDistance: number | null;
}

/** "How often I change this kind of draft": the honest replacement for a model's self-reported confidence (spec 9.3). */
export async function getIntentStats(db: Db, intent: string, now: Date): Promise<IntentStats> {
  const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.execute<{ sent: number; edited: number; median: number | null }>(sql`
    SELECT count(*)::int AS sent,
           (count(*) FILTER (WHERE status = 'edited'))::int AS edited,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY edit_distance) FILTER (WHERE edit_distance IS NOT NULL) AS median
    FROM drafts
    WHERE intent = ${intent}::draft_intent AND status IN ('approved', 'edited') AND created_at > ${since}::timestamptz
  `);
  const row = rows[0];
  return { sent: row?.sent ?? 0, edited: row?.edited ?? 0, medianEditDistance: row?.median === null || row?.median === undefined ? null : Number(row.median) };
}

export interface DraftDetail {
  id: string;
  status: string;
  conversationId: string;
  name: string;
  secondary: string | null;
  windowExpiresAt: Date | null;
  content: string;
  originalContent: string;
  intent: string;
  analysis: string;
  missingFacts: string[];
  riskFlags: string[];
  noReplyNeeded: boolean;
  model: string;
  promptVersion: string;
  styleGuideVersion: number | null;
  fewshotCount: number;
  triggerMessageIds: string[];
  createdAt: Date;
  /** The customer wrote again after this draft's messages: sending needs an explicit "send anyway". */
  stale: boolean;
  stats: IntentStats;
  /** When the autopilot will send it (status `scheduled`), else null. */
  scheduledSendAt: Date | null;
  /** Why the autopilot did NOT send this draft (reason codes), for a draft it looked at and handed to the owner; null when it did not look or it passed. */
  autopilotReasons: string[] | null;
}

interface DetailRow extends Record<string, unknown> {
  id: string;
  status: string;
  conversation_id: string;
  content: string;
  original_content: string;
  intent: string;
  analysis: string;
  missing_facts: string[];
  risk_flags: string[];
  no_reply_needed: boolean;
  model: string;
  prompt_version: string;
  style_guide_version: number | null;
  fewshot_message_ids: string[];
  trigger_message_ids: string[];
  scheduled_send_at: string | Date | null;
  autopilot_decision: { eligible?: boolean; reasons?: string[] } | null;
  created_at: string | Date;
  window_expires_at: string | Date | null;
  display_name: string | null;
  username: string | null;
  phone_e164: string | null;
  bsuid: string | null;
}

export async function getDraftDetail(db: Db, draftId: string, now: Date = new Date()): Promise<DraftDetail | null> {
  const rows = await db.execute<DetailRow>(sql`
    SELECT d.*, c.window_expires_at, ct.display_name, ct.username, ct.phone_e164, ct.bsuid
    FROM drafts d
    JOIN conversations c ON c.id = d.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE d.id = ${draftId}::uuid
  `);
  const row = rows[0];
  if (!row) return null;
  const contact = { displayName: row.display_name, username: row.username, phoneE164: row.phone_e164, bsuid: row.bsuid };
  return {
    id: row.id,
    status: row.status,
    conversationId: row.conversation_id,
    name: displayName(contact),
    secondary: secondaryLine(contact),
    windowExpiresAt: row.window_expires_at === null ? null : toDate(row.window_expires_at),
    content: row.content,
    originalContent: row.original_content,
    intent: row.intent,
    analysis: row.analysis,
    missingFacts: row.missing_facts,
    riskFlags: row.risk_flags,
    noReplyNeeded: row.no_reply_needed,
    model: row.model,
    promptVersion: row.prompt_version,
    styleGuideVersion: row.style_guide_version,
    fewshotCount: row.fewshot_message_ids.length,
    triggerMessageIds: row.trigger_message_ids,
    createdAt: toDate(row.created_at),
    stale: row.status === 'pending' || row.status === 'scheduled' ? await isDraftStale(db, row.conversation_id, row.trigger_message_ids) : false,
    stats: await getIntentStats(db, row.intent, now),
    scheduledSendAt: row.scheduled_send_at === null ? null : toDate(row.scheduled_send_at),
    autopilotReasons: row.autopilot_decision && row.autopilot_decision.eligible === false && Array.isArray(row.autopilot_decision.reasons) ? row.autopilot_decision.reasons : null,
  };
}
