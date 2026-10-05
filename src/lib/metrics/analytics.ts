import 'server-only';
import { sql } from 'drizzle-orm';
import { stampMinute } from '@/lib/ai/prompts/format';
import type { Db, DbOrTx } from '@/lib/db';
import type { AiPriceList } from '@/lib/env';
import { wallTimeToUtc } from '@/lib/import/zoned-time';
import { answeredCte } from './response-time';

/**
 * Everything the Analytics page shows (spec 12), computed in SQL. Days are the OWNER's calendar days (`OWNER_TIMEZONE`): a message at 23:30
 * Kampala time belongs to that day, not to tomorrow's UTC date. Every series is zero-filled over the whole range, so a quiet day is a
 * visible zero, not a missing point. Definitions live next to the queries and are repeated on the page, because a chart without a
 * definition is decoration.
 */

export const RANGE_DAYS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_DAYS)[number];

export interface Range {
  days: RangeDays;
  timeZone: string;
  /** Local calendar days, oldest first, ending with today. */
  dates: string[];
  /** The instant the first day starts (local midnight). */
  since: Date;
  until: Date;
}

const localDate = (date: Date, timeZone: string) => stampMinute(date, timeZone).slice(0, 10);

/** Calendar arithmetic on a `YYYY-MM-DD` string (never on instants: a day is not always 24 hours). */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (date ?? 1) + delta)).toISOString().slice(0, 10);
}

export function buildRange(now: Date, days: RangeDays, timeZone: string): Range {
  const today = localDate(now, timeZone);
  const dates = Array.from({ length: days }, (_, index) => addDays(today, index - (days - 1)));
  const [first] = dates;
  const [year, month, date] = (first ?? today).split('-').map(Number);
  const since = wallTimeToUtc({ year: year ?? 1970, month: month ?? 1, day: date ?? 1, hour: 0, minute: 0, second: 0 }, timeZone);
  return { days, timeZone, dates, since, until: now };
}

function fill<T extends { day: string }>(range: Range, rows: readonly T[], empty: (day: string) => T): T[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return range.dates.map((day) => byDay.get(day) ?? empty(day));
}

const DAY = (column: string, timeZone: string) => sql`to_char((${sql.raw(column)} AT TIME ZONE ${timeZone})::date, 'YYYY-MM-DD')`;
const round = (value: number | null | undefined, places = 4): number | null => (value === null || value === undefined ? null : Number(Number(value).toFixed(places)));

// ------------------------------------------------------------------------------------------------------------------------ volume

export interface VolumeDay {
  day: string;
  inbound: number;
  outbound: number;
}

/** Live messages per day: customers' (inbound) and the owner's accepted ones (outbound, incl. phone-typed). Imported history, reactions and failed sends are not counted. */
export async function getVolume(db: Db, range: Range): Promise<VolumeDay[]> {
  const rows = await db.execute<VolumeDay & Record<string, unknown>>(sql`
    SELECT ${DAY('occurred_at', range.timeZone)} AS day,
           (count(*) FILTER (WHERE direction = 'inbound'))::int AS inbound,
           (count(*) FILTER (WHERE direction = 'outbound' AND status <> 'failed'))::int AS outbound
    FROM messages
    WHERE occurred_at >= ${range.since.toISOString()}::timestamptz AND occurred_at <= ${range.until.toISOString()}::timestamptz
      AND type <> 'reaction' AND provenance <> 'imported'
    GROUP BY 1`);
  return fill(range, rows, (day) => ({ day, inbound: 0, outbound: 0 }));
}

// ------------------------------------------------------------------------------------------------------------------ first response

export interface FirstResponseDay {
  day: string;
  /** Seconds; null on a day with no answered first message. */
  medianSeconds: number | null;
  samples: number;
}

/** Median wait for the owner's first reply, by the day the customer wrote (the definition in `metrics/response-time.ts`). */
export async function getFirstResponse(db: Db, range: Range): Promise<{ byDay: FirstResponseDay[]; medianSeconds: number | null; samples: number }> {
  const daily = await db.execute<{ day: string; median: number | null; n: number }>(sql`
    ${answeredCte(range.since)}
    SELECT ${DAY('asked_at', range.timeZone)} AS day,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM replied_at - asked_at)) AS median, count(*)::int AS n
    FROM answered WHERE replied_at IS NOT NULL GROUP BY 1`);
  const overall = await db.execute<{ median: number | null; n: number }>(sql`
    ${answeredCte(range.since)}
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM replied_at - asked_at)) AS median, count(*)::int AS n
    FROM answered WHERE replied_at IS NOT NULL`);
  const byDay = fill(
    range,
    daily.map((row) => ({ day: row.day, medianSeconds: round(row.median, 1), samples: row.n })),
    (day) => ({ day, medianSeconds: null, samples: 0 }),
  );
  return { byDay, medianSeconds: round(overall[0]?.median, 1), samples: overall[0]?.n ?? 0 };
}

// ------------------------------------------------------------------------------------------------------------------ draft outcomes

export const OUTCOMES = ['unedited', 'edited', 'rejected', 'superseded', 'failed', 'autopilot', 'open'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type OutcomeCounts = Record<Outcome, number>;
export interface OutcomeDay extends OutcomeCounts {
  day: string;
}

const emptyOutcomes = (): OutcomeCounts => ({ unedited: 0, edited: 0, rejected: 0, superseded: 0, failed: 0, autopilot: 0, open: 0 });

/**
 * What happened to the drafts written each day: sent as written, sent after an edit, rejected, replaced (the customer wrote again or a new one
 * was requested), failed, sent by autopilot, or still waiting. A draft whose message went out as `ai_autopilot` is autopilot whatever its status.
 */
export async function getDraftOutcomes(db: Db, range: Range): Promise<{ byDay: OutcomeDay[]; totals: OutcomeCounts }> {
  const rows = await db.execute<{ day: string; outcome: Outcome; n: number }>(sql`
    SELECT ${DAY('d.created_at', range.timeZone)} AS day,
           CASE WHEN m.provenance = 'ai_autopilot' THEN 'autopilot'
                WHEN d.status = 'approved' THEN 'unedited'
                WHEN d.status = 'edited' THEN 'edited'
                WHEN d.status IN ('rejected', 'cancelled') THEN 'rejected'
                WHEN d.status = 'superseded' THEN 'superseded'
                WHEN d.status = 'failed' THEN 'failed'
                ELSE 'open' END AS outcome,
           count(*)::int AS n
    FROM drafts d LEFT JOIN messages m ON m.id = d.final_message_id
    WHERE d.created_at >= ${range.since.toISOString()}::timestamptz AND d.created_at <= ${range.until.toISOString()}::timestamptz
    GROUP BY 1, 2`);
  const days = new Map<string, OutcomeCounts>();
  const totals = emptyOutcomes();
  for (const row of rows) {
    const counts = days.get(row.day) ?? emptyOutcomes();
    counts[row.outcome] += row.n;
    totals[row.outcome] += row.n;
    days.set(row.day, counts);
  }
  return { byDay: range.dates.map((day) => ({ day, ...(days.get(day) ?? emptyOutcomes()) })), totals };
}

// ----------------------------------------------------------------------------------------------------------------- edit distance

export interface EditDistanceDay {
  day: string;
  /** Normalised edit distance, 0 = sent exactly as drafted, 1 = nothing in common; null on a day with nothing sent. */
  median: number | null;
  sent: number;
}

/**
 * The owner's track record: drafts the owner approved (as written or edited) between two instants, with the distance stored at approval.
 * The Analytics page and the autopilot eligibility gate both read THIS query, so the number the owner looks at is the number the gate uses.
 * A draft an autopilot sent has no stored distance and is therefore never part of the record it would be judged on.
 */
export async function editDistanceSummary(db: DbOrTx, since: Date, until: Date): Promise<{ n: number; median: number | null; p75: number | null; edited: number }> {
  const rows = await db.execute<{ median: number | null; p75: number | null; n: number; edited: number }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY edit_distance) AS median, percentile_cont(0.75) WITHIN GROUP (ORDER BY edit_distance) AS p75,
           count(*)::int AS n, (count(*) FILTER (WHERE status = 'edited'))::int AS edited
    FROM drafts
    WHERE status IN ('approved', 'edited') AND edit_distance IS NOT NULL AND approved_at >= ${since.toISOString()}::timestamptz AND approved_at <= ${until.toISOString()}::timestamptz`);
  const row = rows[0];
  return { n: row?.n ?? 0, median: row?.median ?? null, p75: row?.p75 ?? null, edited: row?.edited ?? 0 };
}

/**
 * The primary chart (spec 12): how far the owner's final text is from the draft, by the day it was sent. Only drafts that were actually sent
 * (approved or edited) count; their distance was stored when they were approved. The same numbers feed the autopilot gate.
 */
export async function getEditDistance(db: Db, range: Range): Promise<{ byDay: EditDistanceDay[]; median: number | null; p75: number | null; sent: number; editedShare: number | null }> {
  const daily = await db.execute<{ day: string; median: number | null; n: number }>(sql`
    SELECT ${DAY('approved_at', range.timeZone)} AS day, percentile_cont(0.5) WITHIN GROUP (ORDER BY edit_distance) AS median, count(*)::int AS n
    FROM drafts
    WHERE status IN ('approved', 'edited') AND edit_distance IS NOT NULL AND approved_at >= ${range.since.toISOString()}::timestamptz AND approved_at <= ${range.until.toISOString()}::timestamptz
    GROUP BY 1`);
  const total = await editDistanceSummary(db, range.since, range.until);
  const sent = total.n;
  return {
    byDay: fill(
      range,
      daily.map((row) => ({ day: row.day, median: round(row.median), sent: row.n })),
      (day) => ({ day, median: null, sent: 0 }),
    ),
    median: sent === 0 ? null : round(total.median),
    p75: sent === 0 ? null : round(total.p75),
    sent,
    editedShare: sent === 0 ? null : round(total.edited / sent),
  };
}

// ------------------------------------------------------------------------------------------------------------------------- tasks

export interface TaskTypeRow {
  type: 'request' | 'followup' | 'reminder';
  open: number;
  done: number;
  cancelled: number;
  byAssistant: number;
  byOwner: number;
}

/** Tasks CREATED in the range, by kind, with where they stand now and who noted them. */
export async function getTasksByType(db: Db, range: Range): Promise<TaskTypeRow[]> {
  const rows = await db.execute<{ type: TaskTypeRow['type']; open: number; done: number; cancelled: number; ai: number; owner: number }>(sql`
    SELECT type,
           (count(*) FILTER (WHERE status = 'open'))::int AS open,
           (count(*) FILTER (WHERE status = 'done'))::int AS done,
           (count(*) FILTER (WHERE status = 'cancelled'))::int AS cancelled,
           (count(*) FILTER (WHERE created_by = 'ai'))::int AS ai,
           (count(*) FILTER (WHERE created_by = 'owner'))::int AS owner
    FROM tasks
    WHERE created_at >= ${range.since.toISOString()}::timestamptz AND created_at <= ${range.until.toISOString()}::timestamptz
    GROUP BY type`);
  const byType = new Map(rows.map((row) => [row.type, row]));
  return (['request', 'followup', 'reminder'] as const).map((type) => {
    const row = byType.get(type);
    return { type, open: row?.open ?? 0, done: row?.done ?? 0, cancelled: row?.cancelled ?? 0, byAssistant: row?.ai ?? 0, byOwner: row?.owner ?? 0 };
  });
}

// ------------------------------------------------------------------------------------------------------------------------ AI usage

export interface AiUsageDay {
  day: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  failed: number;
  /** In the owner's currency; null when no price list is configured. */
  cost: number | null;
}

export interface AiUsage {
  byDay: AiUsageDay[];
  byPurpose: Array<{ purpose: string; inputTokens: number; outputTokens: number; calls: number }>;
  totals: { inputTokens: number; outputTokens: number; calls: number; failed: number; cost: number | null };
  currency: string | null;
  /** Models that were used but have no price: the cost is then a lower bound, and the page says so. */
  unpricedModels: string[];
}

/** Tokens and (when the owner supplied prices) cost per day. Tokens are what the provider reported; nothing is estimated and no price is built in. */
export async function getAiUsage(db: Db, range: Range, prices: AiPriceList | null): Promise<AiUsage> {
  const rows = await db.execute<{ day: string; model: string; purpose: string; input: number; output: number; calls: number; failed: number }>(sql`
    SELECT ${DAY('created_at', range.timeZone)} AS day, model, purpose::text AS purpose,
           coalesce(sum(input_tokens), 0)::bigint AS input, coalesce(sum(output_tokens), 0)::bigint AS output,
           count(*)::int AS calls, (count(*) FILTER (WHERE NOT ok))::int AS failed
    FROM ai_runs
    WHERE created_at >= ${range.since.toISOString()}::timestamptz AND created_at <= ${range.until.toISOString()}::timestamptz
    GROUP BY 1, 2, 3`);

  const unpriced = new Set<string>();
  const costOf = (model: string, input: number, output: number): number => {
    const price = prices?.models[model];
    if (!price) {
      if (prices) unpriced.add(model);
      return 0;
    }
    return (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
  };

  const days = new Map<string, AiUsageDay>();
  const purposes = new Map<string, { purpose: string; inputTokens: number; outputTokens: number; calls: number }>();
  for (const row of rows) {
    const input = Number(row.input);
    const output = Number(row.output);
    const day = days.get(row.day) ?? { day: row.day, inputTokens: 0, outputTokens: 0, calls: 0, failed: 0, cost: prices ? 0 : null };
    day.inputTokens += input;
    day.outputTokens += output;
    day.calls += row.calls;
    day.failed += row.failed;
    if (day.cost !== null) day.cost += costOf(row.model, input, output);
    days.set(row.day, day);
    const purpose = purposes.get(row.purpose) ?? { purpose: row.purpose, inputTokens: 0, outputTokens: 0, calls: 0 };
    purpose.inputTokens += input;
    purpose.outputTokens += output;
    purpose.calls += row.calls;
    purposes.set(row.purpose, purpose);
  }
  const byDay = range.dates.map((day) => {
    const found = days.get(day);
    return found ? { ...found, cost: found.cost === null ? null : round(found.cost, 6) } : { day, inputTokens: 0, outputTokens: 0, calls: 0, failed: 0, cost: prices ? 0 : null };
  });
  const sum = (pick: (day: AiUsageDay) => number) => byDay.reduce((total, day) => total + pick(day), 0);
  return {
    byDay,
    byPurpose: [...purposes.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    totals: { inputTokens: sum((d) => d.inputTokens), outputTokens: sum((d) => d.outputTokens), calls: sum((d) => d.calls), failed: sum((d) => d.failed), cost: prices ? round(sum((d) => d.cost ?? 0), 6) : null },
    currency: prices?.currency ?? null,
    unpricedModels: [...unpriced].sort(),
  };
}

// ----------------------------------------------------------------------------------------------------------------------- the lot

export interface Analytics {
  range: Range;
  volume: VolumeDay[];
  firstResponse: Awaited<ReturnType<typeof getFirstResponse>>;
  drafts: Awaited<ReturnType<typeof getDraftOutcomes>>;
  editDistance: Awaited<ReturnType<typeof getEditDistance>>;
  tasks: TaskTypeRow[];
  ai: AiUsage;
}

export async function getAnalytics(db: Db, options: { now: Date; days: RangeDays; timeZone: string; prices: AiPriceList | null }): Promise<Analytics> {
  const range = buildRange(options.now, options.days, options.timeZone);
  const [volume, firstResponse, drafts, editDistance, tasks, ai] = await Promise.all([
    getVolume(db, range),
    getFirstResponse(db, range),
    getDraftOutcomes(db, range),
    getEditDistance(db, range),
    getTasksByType(db, range),
    getAiUsage(db, range, options.prices),
  ]);
  return { range, volume, firstResponse, drafts, editDistance, tasks, ai };
}
