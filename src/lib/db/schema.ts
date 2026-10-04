import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from '../ids';
import type { StyleGuideContent } from '../schemas/style-guide';

/**
 * Conventions: UUID v7 primary keys generated in app code, timestamptz everywhere,
 * pgEnum for enums, typed JSONB, every FK declares onDelete, created_at defaults to now(),
 * updated_at is maintained by app code. Every index comment names the query it serves.
 *
 * Amendments to the original spec (see DECISIONS.md):
 *   A1 contacts: bsuid + phone_e164 (both nullable) + source, replacing wa_user_id
 *   A2 messages.send_started_at (crash guard for the send path)
 *   A3 messages.edited_at / deleted_at
 *   A4 messages.transcription_status
 *   A5 webhook_events.payload nullable (purged after 30 days; the row keeps its dedupe_key)
 */

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().$defaultFn(() => uuidv7());
const createdAt = () => tstz('created_at').notNull().defaultNow();
const updatedAt = () => tstz('updated_at').notNull().defaultNow();

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ---------------------------------------------------------------- enums

export const contactSource = pgEnum('contact_source', ['webhook', 'import_phone', 'import_name']);
export const conversationStatus = pgEnum('conversation_status', ['open', 'waiting_on_me', 'waiting_on_customer', 'resolved']);
export const replyMode = pgEnum('reply_mode', ['approval', 'autopilot']);
export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageType = pgEnum('message_type', [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'template',
  'unsupported',
]);
export const contentSource = pgEnum('content_source', ['text', 'caption', 'transcript', 'rendered', 'template']);
export const provenance = pgEnum('provenance', [
  'customer',
  'owner_manual',
  'owner_app_echo',
  'imported',
  'ai_unedited',
  'ai_edited',
  'ai_autopilot',
]);
export const messageStatus = pgEnum('message_status', ['received', 'queued', 'sent', 'delivered', 'read', 'failed', 'unknown']);
export const transcriptionStatus = pgEnum('transcription_status', ['pending', 'done', 'failed', 'low_confidence']);
export const draftIntent = pgEnum('draft_intent', [
  'question',
  'order',
  'complaint',
  'scheduling',
  'payment',
  'chit_chat',
  'asks_for_human',
  'other',
]);
export const draftStatus = pgEnum('draft_status', [
  'pending',
  'scheduled',
  'approved',
  'edited',
  'rejected',
  'superseded',
  'cancelled',
  'failed',
]);
export const taskType = pgEnum('task_type', ['request', 'followup', 'reminder']);
export const taskStatus = pgEnum('task_status', ['open', 'done', 'cancelled']);
export const taskCreatedBy = pgEnum('task_created_by', ['ai', 'owner']);
export const aiPurpose = pgEnum('ai_purpose', ['draft', 'verify', 'analysis', 'style_extract', 'transcribe', 'eval']);
export const auditActor = pgEnum('audit_actor', ['owner', 'system', 'autopilot']);

// ---------------------------------------------------------------- JSONB shapes

export interface MessageError {
  /** `permanent` or `ambiguous`; `safe_retry` errors are retried and never stored on the message. */
  kind: 'permanent' | 'ambiguous' | 'safe_retry';
  code: string | null;
  message: string;
}

export interface AutopilotDecision {
  eligible: boolean;
  reasons: string[];
  verifier: {
    verdict: 'pass' | 'fail';
    unsupportedClaims: string[];
    commitments: string[];
    answersTheCustomer: boolean;
    toneRisk: boolean;
  } | null;
}

export interface QuietHours {
  start: string;
  end: string;
}

// ---------------------------------------------------------------- tables

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    /** Business-scoped user id. Changes when the customer changes phone number (user_id_update webhook). */
    bsuid: text('bsuid').unique(),
    phoneE164: text('phone_e164').unique(),
    source: contactSource('source').notNull().default('webhook'),
    displayName: text('display_name'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('contacts_identity_present', sql`${t.bsuid} IS NOT NULL OR ${t.phoneE164} IS NOT NULL OR ${t.source} = 'import_name'`),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    contactId: uuid('contact_id')
      .notNull()
      .unique()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    status: conversationStatus('status').notNull().default('open'),
    replyMode: replyMode('reply_mode').notNull().default('approval'),
    autopilotUntil: tstz('autopilot_until'),
    lastInboundAt: tstz('last_inbound_at'),
    lastMessageAt: tstz('last_message_at'),
    windowExpiresAt: tstz('window_expires_at'),
    summary: text('summary'),
    summaryThroughMessageId: uuid('summary_through_message_id'),
    consecutiveAutoReplies: integer('consecutive_auto_replies').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Conversation list: keyset pagination ordered by (last_message_at desc, id desc).
    index('conversations_list_idx').on(t.lastMessageAt.desc(), t.id.desc()),
    // "Expiring soon" list and alerts-scan: windows ordered by expiry.
    index('conversations_window_idx').on(t.windowExpiresAt),
    // Filter conversations by status (waiting_on_me count on the overview).
    index('conversations_status_idx').on(t.status),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    direction: messageDirection('direction').notNull(),
    wamid: text('wamid').unique(),
    idempotencyKey: text('idempotency_key').unique(),
    type: messageType('type').notNull(),
    content: text('content'),
    contentSource: contentSource('content_source'),
    mediaId: text('media_id'),
    mediaMime: text('media_mime'),
    mediaPath: text('media_path'),
    replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    provenance: provenance('provenance').notNull(),
    status: messageStatus('status').notNull(),
    error: jsonb('error').$type<MessageError>(),
    templateName: text('template_name'),
    transcriptionStatus: transcriptionStatus('transcription_status'),
    /** Stamped atomically before the Cloud API call; a re-run that finds it set without a wamid must not resend. */
    sendStartedAt: tstz('send_started_at'),
    editedAt: tstz('edited_at'),
    deletedAt: tstz('deleted_at'),
    occurredAt: tstz('occurred_at').notNull(),
    createdAt: createdAt(),
    contentTsv: tsvector('content_tsv').generatedAlwaysAs(sql`to_tsvector('simple', coalesce(content, ''))`),
  },
  (t) => [
    // Thread view and prompt context: messages of one conversation in time order.
    index('messages_thread_idx').on(t.conversationId, t.occurredAt),
    // Dashboard search and few-shot retrieval: full-text match on message content.
    index('messages_content_tsv_idx').using('gin', t.contentTsv),
    // Problems panel: only messages that are queued, unknown or failed.
    index('messages_problem_idx')
      .on(t.status)
      .where(sql`${t.status} IN ('queued','unknown','failed')`),
  ],
);

export const drafts = pgTable(
  'drafts',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    triggerMessageIds: uuid('trigger_message_ids').array().notNull(),
    content: text('content').notNull(),
    /** As generated; never edited. Provenance and edit distance compare against it. */
    originalContent: text('original_content').notNull(),
    intent: draftIntent('intent').notNull(),
    analysis: text('analysis').notNull(),
    missingFacts: text('missing_facts').array().notNull().default(sql`'{}'::text[]`),
    riskFlags: text('risk_flags').array().notNull().default(sql`'{}'::text[]`),
    noReplyNeeded: boolean('no_reply_needed').notNull().default(false),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    styleGuideVersion: integer('style_guide_version'),
    fewshotMessageIds: uuid('fewshot_message_ids').array().notNull().default(sql`'{}'::uuid[]`),
    status: draftStatus('status').notNull().default('pending'),
    autopilotDecision: jsonb('autopilot_decision').$type<AutopilotDecision>(),
    scheduledSendAt: tstz('scheduled_send_at'),
    finalMessageId: uuid('final_message_id').references(() => messages.id, { onDelete: 'set null' }),
    editDistance: real('edit_distance'),
    approvedAt: tstz('approved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // Approvals queue: oldest actionable drafts first.
    index('drafts_open_idx')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('pending','scheduled')`),
    // Per-conversation draft history and "latest draft for this conversation".
    index('drafts_conversation_idx').on(t.conversationId, t.createdAt.desc()),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    sourceMessageId: uuid('source_message_id').references(() => messages.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    type: taskType('type').notNull(),
    dueAt: tstz('due_at'),
    status: taskStatus('status').notNull().default('open'),
    createdBy: taskCreatedBy('created_by').notNull(),
    alertedOverdueAt: tstz('alerted_overdue_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Tasks page and overdue alerts: open tasks ordered by due date.
    index('tasks_status_due_idx').on(t.status, t.dueAt),
  ],
);

export const styleGuides = pgTable(
  'style_guides',
  {
    id: id(),
    version: integer('version').notNull().unique(),
    content: jsonb('content').$type<StyleGuideContent>().notNull(),
    sourceMessageCount: integer('source_message_count').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    activatedAt: tstz('activated_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // The database guarantees at most one active guide; activation swaps inside one transaction.
    uniqueIndex('style_guides_one_active_idx')
      .on(t.isActive)
      .where(sql`${t.isActive}`),
  ],
);

export const settings = pgTable(
  'settings',
  {
    id: integer('id').primaryKey().default(1),
    ownerName: text('owner_name').notNull().default(''),
    businessName: text('business_name').notNull().default(''),
    businessProfile: text('business_profile').notNull().default(''),
    aiPaused: boolean('ai_paused').notNull().default(false),
    sendingPaused: boolean('sending_paused').notNull().default(false),
    autopilotPaused: boolean('autopilot_paused').notNull().default(true),
    autopilotAllowedIntents: text('autopilot_allowed_intents')
      .array()
      .notNull()
      .default(sql`'{chit_chat,question}'::text[]`),
    autopilotDelaySeconds: integer('autopilot_delay_seconds').notNull().default(120),
    autopilotDisclosure: text('autopilot_disclosure').notNull().default('(sent by my assistant)'),
    autopilotMaxPerConversationPerHour: integer('autopilot_max_per_conversation_per_hour').notNull().default(3),
    autopilotMaxPerDay: integer('autopilot_max_per_day').notNull().default(30),
    autopilotMaxConsecutive: integer('autopilot_max_consecutive').notNull().default(4),
    quietHours: jsonb('quiet_hours')
      .$type<QuietHours>()
      .notNull()
      .default(sql`'{"start":"22:00","end":"07:00"}'::jsonb`),
    notifyTelegram: boolean('notify_telegram').notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [check('settings_singleton', sql`${t.id} = 1`)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    kind: text('kind').notNull(),
    /** Nulled by the purge job after 30 days; the row stays so Meta replays still dedupe. */
    payload: jsonb('payload').$type<unknown>(),
    receivedAt: tstz('received_at').notNull().defaultNow(),
    processedAt: tstz('processed_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    // Sweeper: unprocessed events older than two minutes, oldest first.
    index('webhook_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

export const aiRuns = pgTable('ai_runs', {
  id: id(),
  purpose: aiPurpose('purpose').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  latencyMs: integer('latency_ms').notNull().default(0),
  ok: boolean('ok').notNull(),
  error: text('error'),
  draftId: uuid('draft_id').references(() => drafts.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const evalRuns = pgTable('eval_runs', {
  id: id(),
  promptVersion: text('prompt_version').notNull(),
  model: text('model').notNull(),
  styleGuideVersion: integer('style_guide_version'),
  sampleSize: integer('sample_size').notNull(),
  medianEditDistance: real('median_edit_distance').notNull(),
  inventedFactRate: real('invented_fact_rate').notNull(),
  forbiddenHitRate: real('forbidden_hit_rate').notNull(),
  reportPath: text('report_path').notNull(),
  createdAt: createdAt(),
});

export const notifications = pgTable('notifications', {
  id: id(),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  telegramMessageId: text('telegram_message_id'),
  sentAt: tstz('sent_at').notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actor: auditActor('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    // Audit viewer: newest first with keyset pagination.
    index('audit_log_recent_idx').on(t.createdAt.desc(), t.id.desc()),
    // Audit viewer: filter by action, newest first.
    index('audit_log_action_idx').on(t.action, t.createdAt.desc()),
    // Audit viewer: all entries for one entity.
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
  ],
);

export * from './auth-schema';
