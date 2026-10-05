import 'server-only';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Db, type Tx, getDb } from '@/lib/db';
import { type MessageError, contacts, conversations, drafts, messages, settings } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { refreshConversationAggregates } from '@/lib/ingest/conversations';
import { supersedeOpenDrafts } from '@/lib/drafts/supersede';
import { type Effect, runEffects } from '@/lib/ingest/effects';
import { enqueue } from '@/lib/queue/enqueue';
import { transitionMessage } from '@/lib/state/message-machine';
import { draftStatusesAllowing } from '@/lib/state/draft-machine';
import { type SendOutcome, type TemplateToSend, buildTemplatePayload, buildTextPayload, postMessage } from '@/lib/whatsapp/send-api';
import { type PrecheckCode, precheck } from './precheck';

/**
 * THE send path (spec 6.5). Every outbound message in the system is created by `queueMessage` and delivered by `performSend`;
 * nothing else inserts an outbound row or calls Meta's send endpoint (a test enforces the second half).
 *
 * Two halves with a hard boundary:
 *
 *   queueMessage  (inside the caller's transaction)   lock the conversation -> pre-check -> insert the row as `queued`
 *                 -> for a draft: claim it in the SAME transaction. A failed check THROWS, so the whole transaction rolls
 *                 back and the draft stays `pending`. The caller enqueues the job only AFTER commit.
 *   performSend   (the worker; never inside a transaction across the HTTP call)
 *                 transaction 1: re-check, then stamp `send_started_at` ATOMICALLY, commit
 *                 call Meta (20 s abort)
 *                 transaction 2: record the outcome with the state machine
 *
 * Why the stamp: the Cloud API has no idempotency key. If a worker dies after Meta accepted the message but before we wrote
 * the wamid, any re-run would send it twice. A re-run that finds `send_started_at` set and no wamid therefore marks the
 * message `unknown` and NEVER sends again; the owner decides (mark sent / resend). Only failures where Meta definitively did
 * NOT send (rate limits, a 5xx WITH a Meta error body, a connection never made) clear the stamp and retry.
 */

// ------------------------------------------------------------------------------------------------------------ queueing

export interface ResolvedTemplate extends TemplateToSend {
  /** The body with its values filled in: what the owner and the customer see, and what is pre-checked and stored. */
  renderedContent: string;
}

export type OutboundContent = { kind: 'text'; content: string } | { kind: 'template'; template: ResolvedTemplate };

export type Provenance = 'owner_manual' | 'ai_unedited' | 'ai_edited' | 'ai_autopilot';

export type SendSource =
  /** The owner typed it (or picked a template). */
  | { kind: 'manual' }
  /** An AI draft, approved by the owner (or released by the autopilot). `finalContent` is what is actually sent. */
  | { kind: 'draft'; draftId: string; finalContent: string; overrideStale: boolean; autopilot?: boolean };

export interface QueueMessageInput {
  conversationId: string;
  message: OutboundContent;
  /** The client's key for THIS submission: a double click or a retried request creates one message, not two. */
  idempotencyKey: string;
  source: SendSource;
  /** Used for resends, so the new row keeps the original's provenance. Ignored for drafts (derived from the draft). */
  provenance?: Provenance;
  now?: Date;
}

export interface QueuedMessage {
  messageId: string;
  conversationId: string;
  /** True when this key had already been queued: the existing message is returned and nothing new happens. */
  duplicate: boolean;
  /** Present for a template: the worker needs its components, which are not stored on the row. */
  template: TemplateToSend | null;
}

/** A pre-check refused the message. Thrown inside the transaction so it rolls back; the action layer turns it into a refusal. */
export class SendRefused extends Error {
  constructor(
    readonly code: PrecheckCode | 'not_found' | 'resend_not_supported' | 'not_unknown',
    message: string,
  ) {
    super(message);
    this.name = 'SendRefused';
  }
}

async function isDraftStale(tx: Tx, conversationId: string, triggerMessageIds: readonly string[]): Promise<boolean> {
  const triggers = triggerMessageIds.length === 0 ? sql`NULL::uuid` : sql.join(triggerMessageIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await tx.execute<{ stale: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM messages m
      WHERE m.conversation_id = ${conversationId}::uuid
        AND m.direction = 'inbound' AND m.provenance = 'customer' AND m.type <> 'reaction' AND m.deleted_at IS NULL
        AND m.occurred_at > coalesce((SELECT max(t.occurred_at) FROM messages t WHERE t.id IN (${triggers})), '-infinity'::timestamptz)
    ) AS stale
  `);
  return rows[0]?.stale ?? false;
}

function derivedProvenance(source: SendSource, originalContent: string | null): Provenance {
  if (source.kind === 'manual') return 'owner_manual';
  if (source.autopilot) return 'ai_autopilot';
  return source.finalContent.trim() === (originalContent ?? '').trim() ? 'ai_unedited' : 'ai_edited';
}

/**
 * Locks the conversation, pre-checks, and inserts the outbound row as `queued` in the CALLER's transaction. Throws
 * `SendRefused` (rolling everything back) when a rule fails. Returns what the caller needs to enqueue AFTER commit
 * (`enqueueSend`); never enqueues itself.
 */
export async function queueMessage(tx: Tx, input: QueueMessageInput): Promise<QueuedMessage> {
  const now = input.now ?? new Date();

  // Serialises every send in this conversation, and reads the window as it is right now.
  const [row] = await tx
    .select({ conversation: conversations, contact: contacts })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, input.conversationId))
    .for('update', { of: conversations });
  if (!row) throw new SendRefused('not_found', 'That conversation no longer exists.');

  const template = input.message.kind === 'template' ? { name: input.message.template.name, language: input.message.template.language, components: input.message.template.components } : null;

  // A second submission with the same key is the same message, not a new one.
  const [existing] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) return { messageId: existing.id, conversationId: input.conversationId, duplicate: true, template };

  const [setting] = await tx.select({ sendingPaused: settings.sendingPaused }).from(settings).limit(1);

  let draftRow: typeof drafts.$inferSelect | undefined;
  let content: string;
  let outboundKind: 'text' | 'template';
  if (input.source.kind === 'draft') {
    [draftRow] = await tx.select().from(drafts).where(and(eq(drafts.id, input.source.draftId), eq(drafts.conversationId, input.conversationId))).for('update');
    if (!draftRow) throw new SendRefused('draft_not_open', 'That draft no longer exists.');
    content = input.source.finalContent;
    outboundKind = 'text';
  } else if (input.message.kind === 'text') {
    content = input.message.content;
    outboundKind = 'text';
  } else {
    content = input.message.template.renderedContent;
    outboundKind = 'template';
  }

  const verdict = precheck({
    now,
    sendingPaused: setting?.sendingPaused ?? false,
    windowExpiresAt: row.conversation.windowExpiresAt,
    recipient: { phone: row.contact.phoneE164, bsuid: row.contact.bsuid },
    message: outboundKind === 'text' ? { kind: 'text', content } : { kind: 'template', renderedContent: content },
    ...(input.source.kind === 'draft' && draftRow
      ? {
          draft: {
            status: draftRow.status,
            stale: await isDraftStale(tx, input.conversationId, draftRow.triggerMessageIds),
            overrideStale: input.source.overrideStale,
          },
        }
      : {}),
  });
  if (!verdict.ok) throw new SendRefused(verdict.code, verdict.message);

  const provenance = input.provenance && input.source.kind === 'manual' ? input.provenance : derivedProvenance(input.source, draftRow?.originalContent ?? null);

  const inserted = await tx
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      direction: 'outbound',
      type: outboundKind === 'text' ? 'text' : 'template',
      content,
      contentSource: outboundKind === 'text' ? 'text' : 'template',
      templateName: template?.name ?? null,
      provenance,
      status: 'queued',
      idempotencyKey: input.idempotencyKey,
      occurredAt: now,
    })
    .onConflictDoNothing({ target: messages.idempotencyKey })
    .returning({ id: messages.id });
  const messageId = inserted[0]?.id;
  if (messageId === undefined) {
    // Lost a race on the key between the check above and the insert (cannot happen under the conversation lock, but never assume).
    const [winner] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.idempotencyKey, input.idempotencyKey)).limit(1);
    if (!winner) throw new Error('idempotency conflict without a winner');
    return { messageId: winner.id, conversationId: input.conversationId, duplicate: true, template };
  }

  if (draftRow && input.source.kind === 'draft') {
    // Claim the draft in this same transaction: conditional on its status, so two approvals cannot both win.
    const edited = provenance === 'ai_edited';
    const claimed = await tx
      .update(drafts)
      .set({ status: edited ? 'edited' : 'approved', finalMessageId: messageId, approvedAt: now, content: input.source.finalContent })
      .where(and(eq(drafts.id, draftRow.id), inArray(drafts.status, draftStatusesAllowing(edited ? 'approve_edited' : 'approve'))))
      .returning({ id: drafts.id });
    if (claimed.length === 0) throw new SendRefused('draft_not_open', 'This draft was already handled.');
  }

  await refreshConversationAggregates(tx, input.conversationId);
  // Whatever is still open was written for a conversation that has just moved on.
  await supersedeOpenDrafts(tx, input.conversationId);

  return { messageId, conversationId: input.conversationId, duplicate: false, template };
}

/** After commit: hand the message to the worker, and tell the dashboard. The enqueue failing is survivable (alerts-scan re-enqueues). */
export async function announceQueued(queued: QueuedMessage): Promise<void> {
  if (queued.duplicate) return;
  await enqueue('outbound-send', 'send', { messageId: queued.messageId, ...(queued.template ? { template: queued.template } : {}) }, { jobId: `send:${queued.messageId}` });
  await runEffects([
    { type: 'publish', event: { type: 'message:new', payload: { conversationId: queued.conversationId, messageId: queued.messageId } } },
    { type: 'publish', event: { type: 'conversation:updated', payload: { conversationId: queued.conversationId } } },
  ]);
}

// ------------------------------------------------------------------------------------------------------------ delivering

/** Thrown to make BullMQ retry the job with backoff. Only ever for failures where Meta definitively did NOT send. */
export class SendRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendRetryError';
  }
}

export type PerformOutcome = 'sent' | 'failed' | 'unknown' | 'skipped';

export interface PerformOptions {
  /** The queue's last attempt: a retryable failure is given up on visibly instead of retried. */
  finalAttempt: boolean;
  /** A template message's components (they live in the job, not on the row). */
  template?: TemplateToSend | undefined;
  now?: Date;
  db?: Db;
}

type MessageRow = typeof messages.$inferSelect;
type Recipient = { phone: string | null; bsuid: string | null };

const failure = (message: string, code: string | null = null): MessageError => ({ kind: 'permanent', code, message });
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

const statusEvent = (conversationId: string, messageId: string, status: MessageRow['status']): Effect => ({
  type: 'publish',
  event: { type: 'message:status', payload: { conversationId, messageId, status } },
});
const conversationEvent = (conversationId: string): Effect => ({ type: 'publish', event: { type: 'conversation:updated', payload: { conversationId } } });
const unknownAlert = (messageId: string): Effect => ({
  type: 'alert',
  alert: { kind: 'message_unknown', severity: 'warning', entityId: messageId, dedupeKey: `message_unknown:${messageId}` },
});

/** The outcome is already committed; a lost dashboard event or alert must not turn a sent message into an error. */
async function settle(effects: Effect[]): Promise<void> {
  try {
    await runEffects(effects);
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'send effects failed');
  }
}

async function markFailed(tx: Tx, message: MessageRow, error: MessageError): Promise<Effect[]> {
  const transition = transitionMessage(message.status, { type: 'permanent_error' });
  if (!transition.ok) return [];
  await tx.update(messages).set({ status: 'failed', error }).where(eq(messages.id, message.id));
  return [statusEvent(message.conversationId, message.id, 'failed')];
}

type Claim =
  | { kind: 'done'; outcome: PerformOutcome; effects: Effect[] }
  | { kind: 'proceed'; message: MessageRow; recipient: Recipient };

type Recorded = { outcome: PerformOutcome; effects: Effect[]; retry?: string };

/**
 * Delivers one queued message. See the file header for the two-transaction shape and why `send_started_at` is stamped first.
 * Safe to call any number of times for the same message: it sends at most once, ever.
 * Throws `SendRetryError` (after committing the stamp-clear) when Meta definitively did not send and the queue should retry.
 */
export async function performSend(messageId: string, options: PerformOptions): Promise<PerformOutcome> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  // ---- transaction 1: re-check and STAMP, atomically, before Meta is ever contacted
  const claim = await db.transaction(async (tx): Promise<Claim> => {
    const [message] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('update');
    if (!message || message.direction !== 'outbound' || message.status !== 'queued') return { kind: 'done', outcome: 'skipped', effects: [] };

    if (message.sendStartedAt !== null) {
      if (message.wamid !== null) return { kind: 'done', outcome: 'skipped', effects: [] };
      // An earlier attempt got as far as the stamp and we never recorded an answer. Meta may or may not have the message:
      // we cannot know, so we NEVER send again. The owner (or Meta's status webhook, via our callback id) settles it.
      const error: MessageError = {
        kind: 'ambiguous',
        code: null,
        message: 'Sending was interrupted before we heard back from Meta. The message may or may not have been sent: check your phone, then mark it sent or resend.',
      };
      await tx.update(messages).set({ status: 'unknown', error }).where(eq(messages.id, messageId));
      return { kind: 'done', outcome: 'unknown', effects: [statusEvent(message.conversationId, messageId, 'unknown'), unknownAlert(messageId)] };
    }

    if (message.type === 'template' && !options.template) {
      // The components travel in the job; without them we cannot build the request, and nothing has been stamped or sent.
      const effects = await markFailed(tx, message, failure('The template details were lost before sending (the queue was reset). Please send the template again.', 'template_job_lost'));
      return { kind: 'done', outcome: 'failed', effects };
    }

    const [row] = await tx
      .select({ windowExpiresAt: conversations.windowExpiresAt, phone: contacts.phoneE164, bsuid: contacts.bsuid })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(eq(conversations.id, message.conversationId))
      .limit(1);
    const [setting] = await tx.select({ sendingPaused: settings.sendingPaused }).from(settings).limit(1);
    if (!row) return { kind: 'done', outcome: 'failed', effects: await markFailed(tx, message, failure('The conversation no longer exists.')) };

    // Checked immediately before the send, not only when it was queued: the kill switch and the window can change in between.
    const verdict = precheck({
      now,
      sendingPaused: setting?.sendingPaused ?? false,
      windowExpiresAt: row.windowExpiresAt,
      recipient: { phone: row.phone, bsuid: row.bsuid },
      message: message.type === 'template' ? { kind: 'template', renderedContent: message.content ?? '' } : { kind: 'text', content: message.content ?? '' },
    });
    if (!verdict.ok) return { kind: 'done', outcome: 'failed', effects: await markFailed(tx, message, failure(verdict.message, verdict.code)) };

    const stamped = await tx.update(messages).set({ sendStartedAt: now }).where(and(eq(messages.id, messageId), isNull(messages.sendStartedAt))).returning({ id: messages.id });
    if (stamped.length === 0) return { kind: 'done', outcome: 'skipped', effects: [] };
    return { kind: 'proceed', message, recipient: { phone: row.phone, bsuid: row.bsuid } };
  });

  if (claim.kind === 'done') {
    await settle(claim.effects);
    return claim.outcome;
  }

  // ---- the HTTP call: never inside a transaction. `postMessage` never throws.
  const { message, recipient } = claim;
  const outcome: SendOutcome =
    message.type === 'template' && options.template
      ? await postMessage(buildTemplatePayload(recipient, options.template, message.id))
      : await postMessage(buildTextPayload(recipient, message.content ?? '', message.id));

  // ---- transaction 2: record exactly what happened. Effects (and the retry signal) leave the transaction as DATA and run after commit.
  const recorded = await db.transaction((tx) => recordOutcome(tx, messageId, outcome, { finalAttempt: options.finalAttempt, now }));
  await settle(recorded.effects);
  if (recorded.retry !== undefined) throw new SendRetryError(recorded.retry);
  return recorded.outcome;
}

async function recordOutcome(tx: Tx, messageId: string, outcome: SendOutcome, ctx: { finalAttempt: boolean; now: Date }): Promise<Recorded> {
  const [current] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('update');
  if (!current) return { outcome: 'skipped', effects: [] };
  const conversationId = current.conversationId;

  switch (outcome.kind) {
    case 'accepted': {
      // Meta HAS the message, whatever we believed before. A delivery status may already have beaten us here (matched by our
      // callback id) and the status must never move backward; a row that alerts-scan had parked as `unknown` is now known.
      const transition =
        current.status === 'unknown' ? transitionMessage(current.status, { type: 'owner_mark_sent' }) : transitionMessage(current.status, { type: 'api_accepted' });
      const next = transition.ok && transition.changed ? transition.to : current.status;
      await tx
        .update(messages)
        .set({ wamid: current.wamid ?? outcome.wamid, ...(next !== current.status ? { status: next } : {}), ...(next !== 'failed' ? { error: null } : {}) })
        .where(eq(messages.id, messageId));
      // The thread is now waiting on the customer, unless they have already written again.
      await tx.execute(sql`
        UPDATE conversations SET status = 'waiting_on_customer', updated_at = now(),
               consecutive_auto_replies = CASE WHEN ${current.provenance} = 'ai_autopilot' THEN consecutive_auto_replies + 1 ELSE 0 END
        WHERE id = ${conversationId}::uuid AND (last_inbound_at IS NULL OR last_inbound_at <= ${current.occurredAt.toISOString()}::timestamptz)
      `);
      return { outcome: 'sent', effects: [statusEvent(conversationId, messageId, next), conversationEvent(conversationId)] };
    }
    case 'retry': {
      if (ctx.finalAttempt) {
        const error = failure(`Gave up after repeated attempts. ${outcome.error.message}`, outcome.error.code);
        await tx.update(messages).set({ sendStartedAt: null }).where(eq(messages.id, messageId));
        return { outcome: 'failed', effects: await markFailed(tx, current, error) };
      }
      // Meta definitively did not send it: clear the stamp (COMMITTED, then the queue retries) so the next attempt may proceed.
      await tx.update(messages).set({ sendStartedAt: null }).where(and(eq(messages.id, messageId), isNull(messages.wamid)));
      return { outcome: 'skipped', effects: [], retry: outcome.error.message };
    }
    case 'permanent': {
      const effects = await markFailed(tx, current, outcome.error);
      if (outcome.alert) {
        effects.push({ type: 'alert', alert: { kind: outcome.alert.kind, severity: outcome.alert.severity, entityId: messageId, dedupeKey: `${outcome.alert.kind}:${utcDay(ctx.now)}` } });
      }
      return { outcome: 'failed', effects };
    }
    case 'ambiguous': {
      const transition = transitionMessage(current.status, { type: 'ambiguous_error' });
      if (!transition.ok) return { outcome: 'skipped', effects: [] };
      await tx.update(messages).set({ status: 'unknown', error: outcome.error }).where(eq(messages.id, messageId));
      return { outcome: 'unknown', effects: [statusEvent(conversationId, messageId, 'unknown'), unknownAlert(messageId)] };
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ owner repairs

/**
 * The owner checked their phone and the message IS there. `unknown -> sent` through the state machine; no wamid (we never had
 * one), so a later delivery status finds it by our callback id and fills it in. Runs in the caller's transaction.
 */
export async function markMessageSent(tx: Tx, messageId: string): Promise<{ conversationId: string }> {
  const [message] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('update');
  if (!message || message.direction !== 'outbound') throw new SendRefused('not_found', 'That message no longer exists.');
  const transition = transitionMessage(message.status, { type: 'owner_mark_sent' });
  if (!transition.ok) throw new SendRefused('not_unknown', 'Only a message whose delivery is unknown can be marked as sent.');
  await tx.update(messages).set({ status: transition.to, error: null }).where(eq(messages.id, messageId));
  await tx.execute(sql`
    UPDATE conversations SET status = 'waiting_on_customer', updated_at = now()
    WHERE id = ${message.conversationId}::uuid AND (last_inbound_at IS NULL OR last_inbound_at <= ${message.occurredAt.toISOString()}::timestamptz)
  `);
  return { conversationId: message.conversationId };
}

function resendProvenance(value: MessageRow['provenance']): Provenance {
  return value === 'ai_unedited' || value === 'ai_edited' || value === 'ai_autopilot' ? value : 'owner_manual';
}

/**
 * The owner checked their phone and the message is NOT there. The original closes as `failed` (state machine `owner_resend`)
 * and a NEW queued message with the same content goes through the normal pre-check (so a closed window or a paused switch
 * refuses it). Text only: a template's parameters are not stored on the row, so a template is sent again from the picker.
 */
export async function resendMessage(tx: Tx, messageId: string, now: Date = new Date()): Promise<QueuedMessage> {
  const [original] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('update');
  if (!original || original.direction !== 'outbound') throw new SendRefused('not_found', 'That message no longer exists.');
  const transition = transitionMessage(original.status, { type: 'owner_resend' });
  if (!transition.ok) throw new SendRefused('not_unknown', 'Only a message whose delivery is unknown can be resent.');
  if (original.type !== 'text') throw new SendRefused('resend_not_supported', 'Only text messages can be resent. Send the template again from the template picker.');

  const queued = await queueMessage(tx, {
    conversationId: original.conversationId,
    message: { kind: 'text', content: original.content ?? '' },
    idempotencyKey: `resend:${original.id}`,
    source: { kind: 'manual' },
    provenance: resendProvenance(original.provenance),
    now,
  });
  if (!queued.duplicate) {
    await tx
      .update(messages)
      .set({ status: transition.to, error: { kind: 'permanent', code: 'resent', message: 'Resent as a new message after the delivery could not be confirmed.' } })
      .where(eq(messages.id, original.id));
  }
  return queued;
}
