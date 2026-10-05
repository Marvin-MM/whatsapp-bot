import 'server-only';
import { type SQL, sql } from 'drizzle-orm';

/**
 * The owner's replies that style learning may read, and nothing else. NEVER `ai_unedited` or `ai_autopilot` (spec 9.4): a model that
 * learns from its own output drifts toward its own habits. `ai_edited` is the owner's words (they changed the draft).
 */
export const ELIGIBLE_OWNER_PROVENANCE = ['owner_manual', 'owner_app_echo', 'imported', 'ai_edited'] as const;

const provenanceList = sql.join(ELIGIBLE_OWNER_PROVENANCE.map((value) => sql`${value}`), sql`, `);

/** Customer messages that make up one side of a pair: at most the last five since the owner last spoke. */
export const MAX_CUSTOMER_MESSAGES_PER_PAIR = 5;

/**
 * SQL for every owner message with its stage and the customer side that preceded it. Stage rules mirror `stages.ts` exactly (a parity
 * test enforces it). `nowIso` is only used for the "nothing after it, and 24 hours old" case of `closing`.
 *
 * Columns: id, conversation_id, occurred_at, reply, stage, eligible (provenance + real text), customer_text, customer_ids.
 */
export function pairsCte(nowIso: string): SQL {
  return sql`
    base AS (
      SELECT m.id, m.conversation_id, m.direction, m.type, m.content, m.provenance, m.occurred_at,
             lag(m.occurred_at) OVER w AS prev_at,
             lead(m.occurred_at) OVER w AS next_at,
             lag(m.direction) OVER w AS prev_dir,
             max(m.occurred_at) FILTER (WHERE m.direction = 'outbound') OVER (PARTITION BY m.conversation_id ORDER BY m.occurred_at, m.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_owner_at
      FROM messages m
      WHERE m.type <> 'reaction' AND m.status <> 'failed'
      WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.occurred_at, m.id)
    ),
    seg AS (
      SELECT base.*,
             sum(CASE WHEN prev_at IS NULL OR occurred_at - prev_at >= interval '24 hours' THEN 1 ELSE 0 END)
               OVER (PARTITION BY conversation_id ORDER BY occurred_at, id) AS seg_no
      FROM base
    ),
    staged AS (
      SELECT seg.*,
             CASE
               WHEN direction <> 'outbound' THEN NULL
               WHEN row_number() OVER (PARTITION BY conversation_id, seg_no, direction ORDER BY occurred_at, id) = 1 THEN 'opening'
               WHEN (next_at IS NOT NULL AND next_at - occurred_at >= interval '24 hours')
                 OR (next_at IS NULL AND ${nowIso}::timestamptz - occurred_at >= interval '24 hours') THEN 'closing'
               WHEN prev_dir = 'outbound' THEN 'followup'
               ELSE 'mid'
             END AS stage
      FROM seg
    ),
    pairs AS (
      SELECT r.id, r.conversation_id, r.occurred_at, r.content AS reply, r.stage,
             (r.provenance IN (${provenanceList}) AND r.type = 'text' AND coalesce(btrim(r.content), '') <> '' AND r.content NOT LIKE '%[[%') AS eligible,
             cust.text AS customer_text, cust.ids AS customer_ids
      FROM staged r
      LEFT JOIN LATERAL (
        SELECT string_agg(c.content, E'\n' ORDER BY c.occurred_at, c.id) AS text, array_agg(c.id ORDER BY c.occurred_at, c.id) AS ids
        FROM (
          SELECT i.id, i.content, i.occurred_at
          FROM messages i
          WHERE i.conversation_id = r.conversation_id AND i.direction = 'inbound' AND i.type <> 'reaction'
            AND i.deleted_at IS NULL AND coalesce(btrim(i.content), '') <> ''
            AND i.occurred_at < r.occurred_at
            AND (r.prev_owner_at IS NULL OR i.occurred_at > r.prev_owner_at)
          ORDER BY i.occurred_at DESC, i.id DESC
          LIMIT ${MAX_CUSTOMER_MESSAGES_PER_PAIR}
        ) c
      ) cust ON true
      WHERE r.direction = 'outbound'
    )`;
}
