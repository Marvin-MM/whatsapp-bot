import { eq } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { auditLog, contacts, conversations, drafts, messages, settings, styleGuides, webhookEvents } from '@/lib/db/schema';
import { isUuidv7 } from '@/lib/ids';
import type { StyleGuideContent } from '@/lib/schemas/style-guide';
import { appSql, closeAllDb, expectPgError, migratorSql, resetDb } from '../helpers/db';

const UNIQUE = '23505';
const CHECK = '23514';
const PRIVILEGE = '42501';

let admin: Sql;
let app: Sql;
const db = () => getDb();

beforeAll(() => {
  admin = migratorSql();
  app = appSql();
});

beforeEach(async () => {
  await resetDb(admin);
});

afterAll(async () => {
  await closeAllDb();
});

const emptyGuide: StyleGuideContent = {
  tone: 'warm',
  sentenceLength: 'short',
  punctuationAndCase: 'lowercase',
  emojiUsage: 'rare',
  languageMixing: 'English with Luganda',
  greetingsAndSignoffs: [],
  vocabulary: [],
  commonPhrases: [],
  structuralPatterns: [],
  forbiddenPatterns: [],
};

async function seedConversation(bsuid = 'BSUID.1') {
  const [contact] = await db().insert(contacts).values({ bsuid }).returning();
  if (!contact) throw new Error('contact not created');
  const [conversation] = await db().insert(conversations).values({ contactId: contact.id }).returning();
  if (!conversation) throw new Error('conversation not created');
  return { contact, conversation };
}

describe('contacts identity (A1)', () => {
  it('generates uuid v7 primary keys in app code', async () => {
    const [row] = await db().insert(contacts).values({ bsuid: 'BSUID.v7' }).returning();
    expect(row && isUuidv7(row.id)).toBe(true);
  });

  it('accepts bsuid-only, phone-only and name-only imported contacts', async () => {
    await db().insert(contacts).values({ bsuid: 'BSUID.only' });
    await db().insert(contacts).values({ phoneE164: '+256700000001', source: 'import_phone' });
    await db().insert(contacts).values({ displayName: 'Imported Name', source: 'import_name' });
    expect(await db().select().from(contacts)).toHaveLength(3);
  });

  it('rejects a webhook contact with neither bsuid nor phone', async () => {
    await expectPgError(db().insert(contacts).values({ displayName: 'Nobody', source: 'webhook' }), CHECK);
  });

  it('rejects duplicate bsuid and duplicate phone', async () => {
    await db().insert(contacts).values({ bsuid: 'BSUID.dup', phoneE164: '+256700000002' });
    await expectPgError(db().insert(contacts).values({ bsuid: 'BSUID.dup' }), UNIQUE);
    await expectPgError(db().insert(contacts).values({ phoneE164: '+256700000002', source: 'import_phone' }), UNIQUE);
  });

  it('allows many contacts with a null bsuid or null phone', async () => {
    await db().insert(contacts).values([
      { phoneE164: '+256700000003', source: 'import_phone' },
      { phoneE164: '+256700000004', source: 'import_phone' },
      { bsuid: 'BSUID.a' },
      { bsuid: 'BSUID.b' },
    ]);
    expect(await db().select().from(contacts)).toHaveLength(4);
  });
});

describe('settings singleton', () => {
  it('accepts id=1 with safe defaults (autopilot paused, sending not paused)', async () => {
    const [row] = await db().insert(settings).values({}).returning();
    expect(row?.id).toBe(1);
    expect(row?.autopilotPaused).toBe(true);
    expect(row?.sendingPaused).toBe(false);
    expect(row?.autopilotAllowedIntents).toEqual(['chit_chat', 'question']);
    expect(row?.autopilotDelaySeconds).toBe(120);
    expect(row?.quietHours).toEqual({ start: '22:00', end: '07:00' });
  });

  it('rejects any id other than 1 and a second id=1 row', async () => {
    await expectPgError(db().insert(settings).values({ id: 2 }), CHECK);
    await db().insert(settings).values({});
    await expectPgError(db().insert(settings).values({}), UNIQUE);
  });
});

describe('style_guides: one active guide, enforced by the database', () => {
  const guide = (version: number, isActive: boolean) => ({
    version,
    content: emptyGuide,
    sourceMessageCount: 100,
    isActive,
  });

  it('rejects a second active guide', async () => {
    await db().insert(styleGuides).values(guide(1, true));
    await expectPgError(db().insert(styleGuides).values(guide(2, true)), UNIQUE);
  });

  it('allows any number of inactive guides but unique versions', async () => {
    await db().insert(styleGuides).values([guide(1, false), guide(2, false), guide(3, false)]);
    await expectPgError(db().insert(styleGuides).values(guide(2, false)), UNIQUE);
  });

  it('activation swaps atomically inside one transaction', async () => {
    await db().insert(styleGuides).values([guide(1, true), guide(2, false)]);
    await db().transaction(async (tx) => {
      await tx.update(styleGuides).set({ isActive: false }).where(eq(styleGuides.version, 1));
      await tx.update(styleGuides).set({ isActive: true, activatedAt: new Date() }).where(eq(styleGuides.version, 2));
    });
    const rows = await db().select().from(styleGuides).where(eq(styleGuides.isActive, true));
    expect(rows.map((row) => row.version)).toEqual([2]);
  });

  it('a swap in the wrong order fails and rolls back, leaving the old guide active', async () => {
    await db().insert(styleGuides).values([guide(1, true), guide(2, false)]);
    await expectPgError(
      db().transaction(async (tx) => {
        await tx.update(styleGuides).set({ isActive: true }).where(eq(styleGuides.version, 2));
        await tx.update(styleGuides).set({ isActive: false }).where(eq(styleGuides.version, 1));
      }),
      UNIQUE,
    );
    const rows = await db().select().from(styleGuides).where(eq(styleGuides.isActive, true));
    expect(rows.map((row) => row.version)).toEqual([1]);
  });
});

describe('webhook_events dedupe', () => {
  it('rejects a duplicate dedupe_key and supports ON CONFLICT DO NOTHING', async () => {
    const event = { dedupeKey: 'msg:wamid.1', kind: 'message', payload: { a: 1 } };
    await db().insert(webhookEvents).values(event);
    await expectPgError(db().insert(webhookEvents).values(event), UNIQUE);
    const inserted = await db().insert(webhookEvents).values(event).onConflictDoNothing({ target: webhookEvents.dedupeKey }).returning();
    expect(inserted).toHaveLength(0);
    expect(await db().select().from(webhookEvents)).toHaveLength(1);
  });

  it('allows a purged (null) payload while keeping the dedupe key', async () => {
    await db().insert(webhookEvents).values({ dedupeKey: 'msg:wamid.2', kind: 'message', payload: { a: 1 } });
    await db().update(webhookEvents).set({ payload: null }).where(eq(webhookEvents.dedupeKey, 'msg:wamid.2'));
    const [row] = await db().select().from(webhookEvents);
    expect(row?.payload).toBeNull();
    expect(row?.dedupeKey).toBe('msg:wamid.2');
  });
});

describe('messages', () => {
  const base = { direction: 'inbound' as const, type: 'text' as const, provenance: 'customer' as const, status: 'received' as const };

  it('maintains a generated full-text column over content', async () => {
    const { conversation } = await seedConversation();
    await db().insert(messages).values({ ...base, conversationId: conversation.id, content: 'Do you have the blue dress in stock?', occurredAt: new Date() });
    const hit = await app`SELECT count(*)::int AS n FROM messages WHERE content_tsv @@ plainto_tsquery('simple', 'dress')`;
    const miss = await app`SELECT count(*)::int AS n FROM messages WHERE content_tsv @@ plainto_tsquery('simple', 'shoes')`;
    expect(hit[0]?.n).toBe(1);
    expect(miss[0]?.n).toBe(0);
  });

  it('enforces unique wamid and idempotency_key but allows many nulls', async () => {
    const { conversation } = await seedConversation();
    const row = (extra: Partial<typeof messages.$inferInsert>) => ({
      ...base,
      conversationId: conversation.id,
      occurredAt: new Date(),
      ...extra,
    });
    await db().insert(messages).values([row({}), row({}), row({ wamid: 'wamid.A' }), row({ idempotencyKey: 'key-1' })]);
    await expectPgError(db().insert(messages).values(row({ wamid: 'wamid.A' })), UNIQUE);
    await expectPgError(db().insert(messages).values(row({ idempotencyKey: 'key-1' })), UNIQUE);
  });

  it('cascades from conversation, and sets draft.final_message_id null when the message is deleted', async () => {
    const { conversation } = await seedConversation();
    const [message] = await db()
      .insert(messages)
      .values({ ...base, direction: 'outbound', provenance: 'ai_unedited', status: 'queued', conversationId: conversation.id, occurredAt: new Date() })
      .returning();
    if (!message) throw new Error('message not created');
    const [draft] = await db()
      .insert(drafts)
      .values({
        conversationId: conversation.id,
        triggerMessageIds: [message.id],
        content: 'hi',
        originalContent: 'hi',
        intent: 'chit_chat',
        analysis: 'greeting',
        model: 'test',
        promptVersion: 'draft-v1',
        finalMessageId: message.id,
      })
      .returning();
    if (!draft) throw new Error('draft not created');

    await db().delete(messages).where(eq(messages.id, message.id));
    const [after] = await db().select().from(drafts).where(eq(drafts.id, draft.id));
    expect(after?.finalMessageId).toBeNull();

    await db().delete(conversations).where(eq(conversations.id, conversation.id));
    expect(await db().select().from(drafts)).toHaveLength(0);
  });
});

describe('least-privilege app role', () => {
  it('can insert and read audit_log', async () => {
    await app`INSERT INTO audit_log (id, actor, action, entity_type, entity_id) VALUES (gen_random_uuid(), 'system', 'test.insert', 'test', '1')`;
    const rows = await app`SELECT action FROM audit_log`;
    expect(rows.map((row) => row.action)).toEqual(['test.insert']);
  });

  it('cannot UPDATE, DELETE or TRUNCATE audit_log (append-only at the database level)', async () => {
    await db().insert(auditLog).values({ actor: 'system', action: 'test.immutable', entityType: 'test', entityId: '1' });
    await expectPgError(app`UPDATE audit_log SET action = 'tampered'`, PRIVILEGE);
    await expectPgError(app`DELETE FROM audit_log`, PRIVILEGE);
    await expectPgError(app`TRUNCATE audit_log`, PRIVILEGE);
    const rows = await app`SELECT action FROM audit_log`;
    expect(rows.map((row) => row.action)).toEqual(['test.immutable']);
  });

  it('can read and write ordinary tables', async () => {
    await db().insert(settings).values({});
    await db().update(settings).set({ aiPaused: true }).where(eq(settings.id, 1));
    const [row] = await db().select().from(settings);
    expect(row?.aiPaused).toBe(true);
  });

  it('has no DDL rights', async () => {
    await expectPgError(app`CREATE TABLE app_created_table (id int)`, PRIVILEGE);
    await expectPgError(app`ALTER TABLE contacts ADD COLUMN sneaky text`, '42501');
    await expectPgError(app`DROP TABLE settings`, '42501');
  });

  it('automatically gets DML on tables created by later migrations (default privileges)', async () => {
    await admin`CREATE TABLE later_migration_probe (id int primary key)`;
    try {
      await app`INSERT INTO later_migration_probe (id) VALUES (1)`;
      const rows = await app`SELECT id FROM later_migration_probe`;
      expect(rows).toHaveLength(1);
    } finally {
      await admin`DROP TABLE later_migration_probe`;
    }
  });
});

describe('migration shape', () => {
  it('creates every partial and gin index with its predicate', async () => {
    const rows = await admin<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
    `;
    const def = (name: string) => rows.find((row) => row.indexname === name)?.indexdef ?? '';
    expect(def('messages_problem_idx')).toContain("'queued'");
    expect(def('drafts_open_idx')).toContain("'pending'");
    expect(def('webhook_events_unprocessed_idx')).toContain('IS NULL');
    expect(def('style_guides_one_active_idx')).toContain('UNIQUE');
    expect(def('messages_content_tsv_idx')).toContain('gin');
    expect(def('conversations_list_idx')).toContain('DESC');
  });

  it('uses timestamptz for every timestamp column', async () => {
    const rows = await admin<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
    `;
    expect(rows).toEqual([]);
  });

  it('draft array columns are NOT NULL and default to empty arrays', async () => {
    const { conversation } = await seedConversation();
    const [draft] = await db()
      .insert(drafts)
      .values({
        conversationId: conversation.id,
        triggerMessageIds: [],
        content: 'hi',
        originalContent: 'hi',
        intent: 'other',
        analysis: 'n/a',
        model: 'test',
        promptVersion: 'draft-v1',
      })
      .returning();
    expect(draft?.missingFacts).toEqual([]);
    expect(draft?.riskFlags).toEqual([]);
    expect(draft?.fewshotMessageIds).toEqual([]);
    expect(draft?.status).toBe('pending');
  });
});
