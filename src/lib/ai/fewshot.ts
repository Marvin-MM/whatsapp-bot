import 'server-only';
import { sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { pairsCte } from './fewshot-sql';
import type { Stage } from './stages';

/**
 * Few-shot retrieval (spec 9.4). A PAIR is the customer message(s) that immediately preceded one of the owner's replies, and that
 * reply. Only the owner's own words qualify (`ELIGIBLE_OWNER_PROVENANCE`: never `ai_unedited` / `ai_autopilot`, and never a reply that
 * still carries a `[[placeholder]]`).
 *
 * Selection: up to 3 pairs from the same stage as the reply being written, then the best-matching of everything else, up to 8 in all,
 * ranked by Postgres full-text rank of the customer side against the new burst (ties: newest first). At most 2 pairs from one
 * conversation, none from the last 24 hours of the current conversation (they are in the prompt already), none the caller excludes
 * (the evaluation's held-out replies), and no two identical replies (eight "ok"s teach nothing).
 */

export interface FewShotExample {
  replyMessageId: string;
  conversationId: string;
  stage: Stage;
  /** Null when the owner wrote with no customer message before it (a follow-up). */
  customerText: string | null;
  reply: string;
  occurredAt: Date;
  rank: number;
}

export interface FewShotRequest {
  conversationId: string;
  /** The customer messages the new reply answers, as one text. */
  burstText: string;
  /** `opening` or `mid` (see `stageOfNextReply`). */
  stage: 'opening' | 'mid';
  now: Date;
  /** Owner reply ids that must not be used (the evaluation's held-out sample). */
  excludeReplyIds?: readonly string[];
  limit?: number;
  sameStageQuota?: number;
  perConversation?: number;
}

export const DEFAULT_LIMIT = 8;
export const DEFAULT_SAME_STAGE = 3;
export const DEFAULT_PER_CONVERSATION = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAME_STAGE_CANDIDATES = 60;
const OTHER_CANDIDATES = 240;

interface Row extends Record<string, unknown> {
  id: string;
  conversation_id: string;
  occurred_at: string;
  reply: string;
  stage: Stage;
  customer_text: string | null;
  rank: number | null;
  same_stage: boolean;
}

const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');

/** Pure selection over ranked candidates, so the policy is unit-tested without a database. */
export function chooseExamples(candidates: readonly FewShotExample[], stage: 'opening' | 'mid', options: { limit?: number; sameStageQuota?: number; perConversation?: number } = {}): FewShotExample[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const quota = options.sameStageQuota ?? DEFAULT_SAME_STAGE;
  const cap = options.perConversation ?? DEFAULT_PER_CONVERSATION;
  const perConversation = new Map<string, number>();
  const usedReplies = new Set<string>();
  const chosen: FewShotExample[] = [];

  const take = (example: FewShotExample): boolean => {
    const reply = normalise(example.reply);
    if (usedReplies.has(reply) || (perConversation.get(example.conversationId) ?? 0) >= cap) return false;
    usedReplies.add(reply);
    perConversation.set(example.conversationId, (perConversation.get(example.conversationId) ?? 0) + 1);
    chosen.push(example);
    return true;
  };

  // Best match first; ties newest first; a pair with no customer text sorts after every pair that has one.
  const ordered = [...candidates].sort(
    (a, b) => Number(a.customerText === null) - Number(b.customerText === null) || b.rank - a.rank || b.occurredAt.getTime() - a.occurredAt.getTime(),
  );
  for (const example of ordered) {
    if (chosen.length >= Math.min(quota, limit)) break;
    if (example.stage === stage) take(example);
  }
  for (const example of ordered) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(example)) take(example);
  }
  return chosen;
}

export async function selectFewShot(db: Db, request: FewShotRequest): Promise<FewShotExample[]> {
  const nowIso = request.now.toISOString();
  const recentCutoff = new Date(request.now.getTime() - DAY_MS).toISOString();
  const excluded = request.excludeReplyIds ?? [];
  const excludeClause = excluded.length === 0 ? sql`` : sql`AND id NOT IN (${sql.join(excluded.map((id) => sql`${id}::uuid`), sql`, `)})`;

  const rows = await db.execute<Row>(sql`
    WITH ${pairsCte(nowIso)},
    q AS (
      SELECT string_agg(quote_literal(lexeme), ' | ')::tsquery AS tsq
      FROM (SELECT lexeme FROM unnest(to_tsvector('simple', ${request.burstText})) WHERE length(lexeme) >= 3 ORDER BY length(lexeme) DESC, lexeme LIMIT 30) words
    ),
    candidates AS (
      SELECT p.id, p.conversation_id, p.occurred_at, p.reply, p.stage, p.customer_text,
             coalesce(CASE WHEN p.customer_text IS NULL THEN 0 ELSE ts_rank(to_tsvector('simple', p.customer_text), (SELECT tsq FROM q)) END, 0) AS rank,
             (p.stage = ${request.stage}) AS same_stage
      FROM pairs p
      WHERE p.eligible
        AND NOT (p.conversation_id = ${request.conversationId}::uuid AND p.occurred_at > ${recentCutoff}::timestamptz)
        ${excludeClause}
    ),
    numbered AS (
      SELECT candidates.*, row_number() OVER (PARTITION BY same_stage ORDER BY (customer_text IS NULL), rank DESC, occurred_at DESC) AS n FROM candidates
    )
    SELECT id, conversation_id, occurred_at, reply, stage, customer_text, rank, same_stage
    FROM numbered
    WHERE (same_stage AND n <= ${SAME_STAGE_CANDIDATES}) OR (NOT same_stage AND n <= ${OTHER_CANDIDATES})
  `);

  const candidates: FewShotExample[] = rows.map((row) => ({
    replyMessageId: row.id,
    conversationId: row.conversation_id,
    stage: row.stage,
    customerText: row.customer_text,
    reply: row.reply,
    occurredAt: new Date(row.occurred_at),
    rank: Number(row.rank ?? 0),
  }));
  return chooseExamples(candidates, request.stage, {
    ...(request.limit === undefined ? {} : { limit: request.limit }),
    ...(request.sameStageQuota === undefined ? {} : { sameStageQuota: request.sameStageQuota }),
    ...(request.perConversation === undefined ? {} : { perConversation: request.perConversation }),
  });
}

export interface PairRow {
  replyMessageId: string;
  conversationId: string;
  stage: Stage;
  customerText: string | null;
  customerMessageIds: string[];
  reply: string;
  occurredAt: Date;
}

interface PairQueryRow extends Record<string, unknown> {
  id: string;
  conversation_id: string;
  occurred_at: string;
  reply: string;
  stage: Stage;
  customer_text: string | null;
  customer_ids: string[] | null;
}

/** Eligible (customer -> owner reply) pairs, newest first. Used by the evaluation's held-out sample and by style extraction's counts. */
export async function listPairs(db: Db, options: { now: Date; limit: number; requireCustomerText?: boolean; before?: Date }): Promise<PairRow[]> {
  const before = options.before ? sql`AND p.occurred_at < ${options.before.toISOString()}::timestamptz` : sql``;
  const customer = options.requireCustomerText === false ? sql`` : sql`AND p.customer_text IS NOT NULL`;
  const rows = await db.execute<PairQueryRow>(sql`
    WITH ${pairsCte(options.now.toISOString())}
    SELECT p.id, p.conversation_id, p.occurred_at, p.reply, p.stage, p.customer_text, p.customer_ids
    FROM pairs p
    WHERE p.eligible ${customer} ${before}
    ORDER BY p.occurred_at DESC, p.id DESC
    LIMIT ${options.limit}
  `);
  return rows.map((row) => ({
    replyMessageId: row.id,
    conversationId: row.conversation_id,
    stage: row.stage,
    customerText: row.customer_text,
    customerMessageIds: row.customer_ids ?? [],
    reply: row.reply,
    occurredAt: new Date(row.occurred_at),
  }));
}
