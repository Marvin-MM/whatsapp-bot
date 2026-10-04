import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { persistEvents } from '@/lib/ingest/persist';
import { type ProcessOutcome, processWebhookEvent } from '@/lib/ingest/process-event';
import { closeProducerConnection } from '@/lib/queue/connection';
import { closeQueues } from '@/lib/queue/queues';
import { type DashboardEvent, dashboardChannel, parseDashboardEvent } from '@/lib/realtime/events';
import { parseEnvelope } from '@/lib/whatsapp/webhook-schema';
import { splitEnvelope } from '@/lib/whatsapp/webhook-split';
import { closeAllDb, migratorSql, resetDb } from './db';
import { fixtureJson } from './fixtures';
import { cleanupPrefix, createTestRedis, uniquePrefix } from './redis';

/** The base time the webhook fixtures were generated around: 2026-10-04T07:46:40Z. */
export const T0 = new Date(1791100000 * 1000);
/** "Now" for processing: an hour after T0, comfortably inside the 24h window of T0 messages. */
export const NOW = new Date(T0.getTime() + 60 * 60 * 1000);
export const HOUR = 60 * 60 * 1000;

export interface IngestOptions {
  now?: Date;
  /** Default true so a status for an unknown message settles instead of throwing RetryLaterError. */
  finalAttempt?: boolean;
}

export interface IngestResult {
  keys: string[];
  outcomes: ProcessOutcome[];
}

/** Meta's POST, minus the HTTP: split -> persist -> process every pending event in payload order. */
export async function ingestPayload(json: unknown, options: IngestOptions = {}): Promise<IngestResult> {
  const parsed = parseEnvelope(json);
  if (!parsed.ok) throw new Error(`test payload is not a valid envelope: ${parsed.reason}`);
  const items = splitEnvelope(parsed.envelope);
  const pending = new Set(await persistEvents(getDb(), items));
  const keys = items.map((item) => item.dedupeKey).filter((key) => pending.has(key));
  const outcomes: ProcessOutcome[] = [];
  for (const key of keys) {
    outcomes.push(await processWebhookEvent(key, { finalAttempt: options.finalAttempt ?? true, now: options.now ?? NOW }));
  }
  return { keys, outcomes };
}

export const ingestFixture = (name: string, options: IngestOptions = {}) => ingestPayload(fixtureJson(name), options);

/** A deep copy of a fixture, for tests that need a variation of it. */
export function cloneFixture(name: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixtureJson(name))) as Record<string, unknown>;
}

/** Wraps one change in a valid envelope. `value.metadata` defaults to the fixture business number. */
export function envelopeOf(field: string, value: Record<string, unknown>, time = 1791100000): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '100000000000002',
        time,
        changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '256700000001', phone_number_id: '100000000000001' }, ...value } }],
      },
    ],
  };
}

export interface Harness {
  admin: () => Sql;
  events: () => Promise<DashboardEvent[]>;
  mediaJobs: () => Promise<Array<{ id: string | undefined; messageId: string }>>;
  clearMediaJobs: () => Promise<void>;
}

/**
 * Registers the lifecycle every ingest test file needs: a clean database per test, a Redis subscriber that captures
 * dashboard events, and a handle on the `download-media` queue. Call once at the top level of the test file.
 */
export function setupIngestHarness(): Harness {
  const prefix = uniquePrefix();
  process.env.BULLMQ_PREFIX = prefix;

  let admin: Sql;
  let subscriber: Redis;
  let cleaner: Redis;
  let mediaQueue: Queue;
  const received: DashboardEvent[] = [];

  beforeAll(async () => {
    admin = migratorSql();
    subscriber = createTestRedis();
    cleaner = createTestRedis();
    subscriber.on('message', (_channel: string, message: string) => {
      const event = parseDashboardEvent(message);
      if (event) received.push(event);
    });
    await subscriber.subscribe(dashboardChannel(getEnv().BULLMQ_PREFIX));
    mediaQueue = new Queue('download-media', { connection: createTestRedis(), prefix });
  });

  beforeEach(async () => {
    await resetDb(admin);
    received.length = 0;
    await mediaQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await mediaQueue.close();
    await subscriber.quit();
    await closeQueues();
    await closeProducerConnection();
    await cleanupPrefix(cleaner, prefix);
    await cleaner.quit();
    await closeAllDb();
  });

  return {
    admin: () => admin,
    events: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return [...received];
    },
    mediaJobs: async () => {
      const jobs = await mediaQueue.getJobs(['waiting', 'delayed', 'prioritized']);
      return jobs.map((job) => ({ id: job.id, messageId: (job.data as { messageId: string }).messageId }));
    },
    clearMediaJobs: () => mediaQueue.obliterate({ force: true }),
  };
}

// ------------------------------------------------------------------ seeding (raw SQL as the table owner)

export async function seedContact(
  admin: Sql,
  o: { bsuid?: string | null; phone?: string | null; name?: string | null; source?: 'webhook' | 'import_phone' | 'import_name'; username?: string | null } = {},
): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO contacts (id, bsuid, phone_e164, display_name, source, username)
    VALUES (gen_random_uuid(), ${o.bsuid ?? null}, ${o.phone ?? null}, ${o.name ?? null}, ${o.source ?? 'webhook'}, ${o.username ?? null})
    RETURNING id`;
  if (!row) throw new Error('seedContact failed');
  return row.id;
}

export async function seedConversation(
  admin: Sql,
  contactId: string,
  o: { status?: 'open' | 'waiting_on_me' | 'waiting_on_customer' | 'resolved'; consecutiveAutoReplies?: number; summary?: string | null } = {},
): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO conversations (id, contact_id, status, consecutive_auto_replies, summary)
    VALUES (gen_random_uuid(), ${contactId}, ${o.status ?? 'open'}, ${o.consecutiveAutoReplies ?? 0}, ${o.summary ?? null})
    RETURNING id`;
  if (!row) throw new Error('seedConversation failed');
  return row.id;
}

export async function seedMessage(
  admin: Sql,
  conversationId: string,
  o: {
    id?: string;
    direction?: 'inbound' | 'outbound';
    wamid?: string | null;
    type?: string;
    content?: string | null;
    provenance?: string;
    status?: string;
    occurredAt?: Date;
    mediaId?: string | null;
  } = {},
): Promise<string> {
  const direction = o.direction ?? 'inbound';
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO messages (id, conversation_id, direction, wamid, type, content, provenance, status, occurred_at, media_id)
    VALUES (coalesce(${o.id ?? null}::uuid, gen_random_uuid()), ${conversationId}, ${direction}, ${o.wamid ?? null}, ${o.type ?? 'text'},
            ${o.content === undefined ? 'seeded' : o.content}, ${o.provenance ?? (direction === 'inbound' ? 'customer' : 'owner_manual')},
            ${o.status ?? (direction === 'inbound' ? 'received' : 'sent')}, ${o.occurredAt ?? T0}, ${o.mediaId ?? null})
    RETURNING id`;
  if (!row) throw new Error('seedMessage failed');
  return row.id;
}

export async function seedDraft(admin: Sql, conversationId: string, status: string, triggerMessageIds: string[] = []): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status)
    VALUES (gen_random_uuid(), ${conversationId}, ${admin.array(triggerMessageIds)}::uuid[], 'draft', 'draft', 'question', 'analysis', 'm', 'p', ${status})
    RETURNING id`;
  if (!row) throw new Error('seedDraft failed');
  return row.id;
}

export async function count(admin: Sql, table: string, where = 'true'): Promise<number> {
  const [row] = await admin.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return row?.n ?? 0;
}
