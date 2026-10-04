import 'server-only';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { type Db, type Tx, getDb } from '@/lib/db';
import { webhookEvents } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  appStateItemSchema,
  echoItemSchema,
  historyItemSchema,
  messageItemSchema,
  otherItemSchema,
  statusItemSchema,
  userIdUpdateItemSchema,
  userPreferenceItemSchema,
} from '@/lib/whatsapp/webhook-schema';
import { handleOther } from './account';
import { type HandlerResult, type IngestContext, RetryLaterError, nothing } from './context';
import { ingestEcho } from './echoes';
import { type Effect, runEffects } from './effects';
import { ingestHistory } from './history';
import { applyAppState, applyUserIdUpdate } from './identity';
import { ingestInboundMessage } from './messages';
import { applyStatus } from './statuses';

export type ProcessOutcome = 'processed' | 'already_processed' | 'missing' | 'parked';

export interface ProcessOptions {
  /** True on BullMQ's last attempt: handlers waiting for a related row settle instead of retrying again. */
  finalAttempt: boolean;
  /** Injected clock for tests. */
  now?: Date;
  db?: Db;
}

/** A short, content-free description of a failure for `webhook_events.last_error`: never a message body or a value. */
export function describeError(error: unknown): string {
  if (error instanceof ZodError) return `zod: ${error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ')}`.slice(0, 300);
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${error.message}`.slice(0, 300);
  }
  return 'unknown error';
}

type Dispatch = (tx: Tx, payload: unknown, ctx: IngestContext) => Promise<HandlerResult>;

/** One entry per `webhook_events.kind`: validate the stored item against its schema, then hand it to its handler. */
const HANDLERS: Readonly<Record<string, Dispatch>> = {
  message: (tx, payload, ctx) => ingestInboundMessage(tx, messageItemSchema.parse(payload), ctx),
  status: async (tx, payload) => {
    const item = statusItemSchema.parse(payload);
    const result = await applyStatus(tx, item.status);
    // The message row may simply not be committed yet (or the status raced the send worker's write): wait, then settle.
    return result.outcome === 'unknown_message' ? { effects: [], note: 'status_for_unknown_message' } : { effects: result.effects };
  },
  echo: (tx, payload, ctx) => ingestEcho(tx, echoItemSchema.parse(payload), ctx),
  history: (tx, payload, ctx) => ingestHistory(tx, historyItemSchema.parse(payload), ctx),
  app_state: (tx, payload) => applyAppState(tx, appStateItemSchema.parse(payload)),
  user_id_update: (tx, payload) => applyUserIdUpdate(tx, userIdUpdateItemSchema.parse(payload)),
  // Marketing opt-in/out: we send no marketing messages in v1, so there is nothing to act on. Validated and recorded.
  user_preferences: async (_tx, payload) => {
    userPreferenceItemSchema.parse(payload);
    return nothing('user_preferences_recorded');
  },
  account: async (_tx, payload, ctx) => handleOther(otherItemSchema.parse(payload), ctx),
  other: async (_tx, payload, ctx) => handleOther(otherItemSchema.parse(payload), ctx),
};

/** Reads the owner's number and the phone-number id Meta put in the item's metadata, whatever the kind. */
function metadataOf(payload: unknown): { displayPhoneNumber: string | null; phoneNumberId: string | null } {
  const metadata = typeof payload === 'object' && payload !== null ? (payload as { metadata?: unknown }).metadata : undefined;
  const record = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  return { displayPhoneNumber: text(record.display_phone_number), phoneNumberId: text(record.phone_number_id) };
}

async function settle(db: Db, id: string, now: Date, note: string | null): Promise<void> {
  await db.update(webhookEvents).set({ processedAt: now, lastError: note }).where(eq(webhookEvents.id, id));
}

/**
 * Processes one stored webhook event (spec 6.1, the part after the 200).
 *
 *   1. load the row; an already-processed event is a replay and does nothing;
 *   2. validate the stored item against its schema: a row that cannot be parsed will never parse, so it is settled with an
 *      alert instead of being retried forever;
 *   3. an event for ANOTHER phone number id is not ours: settled and ignored;
 *   4. run the handler inside one transaction (all writes or none);
 *   5. AFTER commit: enqueue jobs, publish dashboard events, raise alerts;
 *   6. only then stamp `processed_at`.
 *
 * Because `processed_at` comes last and every handler is idempotent (`messages.wamid` UNIQUE, conditional state machines),
 * a crash or a failed enqueue at any point is repaired by a retry or by the sweeper, never by hand.
 */
export async function processWebhookEvent(dedupeKey: string, options: ProcessOptions): Promise<ProcessOutcome> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.dedupeKey, dedupeKey)).limit(1);
  if (!row) {
    logger.warn('webhook event row not found for job');
    return 'missing';
  }
  if (row.processedAt !== null) return 'already_processed';

  const handler = HANDLERS[row.kind];
  if (row.payload === null || row.payload === undefined) {
    await settle(db, row.id, now, 'payload_purged');
    return 'parked';
  }
  if (!handler) {
    await settle(db, row.id, now, 'unknown_event_kind');
    return 'parked';
  }

  const env = getEnv();
  const { displayPhoneNumber, phoneNumberId } = metadataOf(row.payload);
  if (phoneNumberId !== null && phoneNumberId !== env.WHATSAPP_PHONE_NUMBER_ID) {
    logger.warn({ eventId: row.id, kind: row.kind }, 'webhook event for a different phone number id ignored');
    await settle(db, row.id, now, 'foreign_phone_number');
    return 'parked';
  }

  const ctx: IngestContext = {
    now,
    ownNumber: displayPhoneNumber,
    transcribeAudio: env.TRANSCRIBE_AUDIO,
    eventKey: row.dedupeKey,
    finalAttempt: options.finalAttempt,
  };

  let result: HandlerResult;
  try {
    result = await db.transaction((tx) => handler(tx, row.payload, ctx));
  } catch (error) {
    if (error instanceof ZodError) {
      // Deterministic: the same stored item will fail the same way. Park it where the owner can see it.
      logger.error({ eventId: row.id, kind: row.kind, error: describeError(error) }, 'stored webhook item failed validation');
      await settle(db, row.id, now, describeError(error));
      await runEffects([
        { type: 'alert', alert: { kind: 'webhook_item_invalid', severity: 'warning', entityId: row.kind, dedupeKey: `webhook_item_invalid:${row.dedupeKey}` } },
      ]);
      return 'parked';
    }
    if (error instanceof RetryLaterError && options.finalAttempt) {
      // Cannot happen (handlers settle on the final attempt), but never loop forever if a handler forgets.
      await settle(db, row.id, now, `gave_up: ${error.message}`);
      return 'parked';
    }
    await db.update(webhookEvents).set({ lastError: describeError(error) }).where(eq(webhookEvents.id, row.id));
    throw error;
  }

  // A live status for a message we do not hold yet: retry with backoff while attempts remain.
  if (row.kind === 'status' && result.note === 'status_for_unknown_message' && !options.finalAttempt) {
    await db.update(webhookEvents).set({ lastError: 'status_for_unknown_message' }).where(eq(webhookEvents.id, row.id));
    throw new RetryLaterError('status_for_unknown_message');
  }

  try {
    await runEffects(result.effects as Effect[]);
  } catch (error) {
    await db.update(webhookEvents).set({ lastError: describeError(error) }).where(eq(webhookEvents.id, row.id));
    throw error;
  }
  await settle(db, row.id, now, result.note ?? null);
  return 'processed';
}
