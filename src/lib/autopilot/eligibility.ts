import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { chatModelId } from '@/lib/ai/models';
import { DRAFT_PROMPT_VERSION } from '@/lib/ai/prompts/draft';
import type { DbOrTx } from '@/lib/db';
import { evalRuns, styleGuides } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { editDistanceSummary } from '@/lib/metrics/analytics';

/**
 * The system-wide eligibility gate (spec 10.1, made stricter by the owner: D-092). Autopilot may be switched on, anywhere, only when ALL of
 * these hold. Computed live from the database every time it is asked, never cached, and every check carries the numbers behind it so the
 * owner can see how close or how far they are.
 *
 *   The last evaluation (`pnpm eval:drafts`, which holds out the owner's own recent replies and drafts them again):
 *     - exists, is at most 30 days old, and used at least 50 samples;
 *     - was run with the prompt version, model and style guide that are active NOW (a different model or prompt has not been measured);
 *     - median edit distance at or below the threshold, and ZERO invented facts.
 *   The production record (drafts the owner actually approved or edited in the last 30 days):
 *     - at least 200 of them;
 *     - median edit distance at or below the threshold, and 75th percentile at or below 0.50 (a few good drafts must not hide many bad ones).
 */
export const GATE = {
  evalMaxAgeDays: 30,
  evalMinSamples: 50,
  recordWindowDays: 30,
  recordMinApproved: 200,
  /** The 75th percentile ceiling for the production record. The median threshold itself is `AUTOPILOT_MAX_EDIT_DISTANCE`. */
  maxP75: 0.5,
} as const;

export const GATE_CHECK_IDS = ['eval_exists', 'eval_fresh', 'eval_samples', 'eval_current', 'eval_median', 'eval_invented', 'record_volume', 'record_median', 'record_p75'] as const;
export type GateCheckId = (typeof GATE_CHECK_IDS)[number];

export interface GateCheck {
  id: GateCheckId;
  ok: boolean;
  title: string;
  /** The numbers: what was measured and what it must be. */
  detail: string;
}

export interface Eligibility {
  eligible: boolean;
  checks: GateCheck[];
}

export interface LatestEval {
  createdAt: Date;
  sampleSize: number;
  medianEditDistance: number;
  inventedFactRate: number;
  promptVersion: string;
  model: string;
  styleGuideVersion: number | null;
}

export interface GateFacts {
  now: Date;
  /** `AUTOPILOT_MAX_EDIT_DISTANCE`. */
  threshold: number;
  active: { promptVersion: string; model: string; styleGuideVersion: number | null };
  latestEval: LatestEval | null;
  record: { n: number; median: number | null; p75: number | null };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const fixed = (value: number) => value.toFixed(2);
const guide = (version: number | null) => (version === null ? 'no style guide' : `style guide v${version}`);
const NO_EVAL = 'No evaluation has been run yet. Run `pnpm eval:drafts`.';

/** Pure: the nine checks for one set of facts. */
export function evaluateGate(facts: GateFacts): Eligibility {
  const { latestEval: evalRun, record, threshold, now } = facts;
  const ageDays = evalRun ? (now.getTime() - evalRun.createdAt.getTime()) / DAY_MS : null;

  const check = (id: GateCheckId, title: string, ok: boolean, detail: string): GateCheck => ({ id, title, ok, detail });
  const missing = (id: GateCheckId, title: string) => check(id, title, false, NO_EVAL);

  const checks: GateCheck[] = [
    evalRun
      ? check('eval_exists', 'An evaluation of the drafts exists', true, `Last run ${Math.floor(ageDays ?? 0)} days ago.`)
      : check('eval_exists', 'An evaluation of the drafts exists', false, NO_EVAL),
    evalRun && ageDays !== null
      ? check('eval_fresh', `The evaluation is at most ${GATE.evalMaxAgeDays} days old`, ageDays <= GATE.evalMaxAgeDays, `It is ${Math.floor(ageDays)} days old.`)
      : missing('eval_fresh', `The evaluation is at most ${GATE.evalMaxAgeDays} days old`),
    evalRun
      ? check('eval_samples', `The evaluation used at least ${GATE.evalMinSamples} of your replies`, evalRun.sampleSize >= GATE.evalMinSamples, `It used ${evalRun.sampleSize}.`)
      : missing('eval_samples', `The evaluation used at least ${GATE.evalMinSamples} of your replies`),
    evalRun
      ? check(
          'eval_current',
          'The evaluation used the prompt, model and style guide in use now',
          evalRun.promptVersion === facts.active.promptVersion && evalRun.model === facts.active.model && evalRun.styleGuideVersion === facts.active.styleGuideVersion,
          `Evaluated: ${evalRun.promptVersion}, ${evalRun.model}, ${guide(evalRun.styleGuideVersion)}. In use now: ${facts.active.promptVersion}, ${facts.active.model}, ${guide(facts.active.styleGuideVersion)}.`,
        )
      : missing('eval_current', 'The evaluation used the prompt, model and style guide in use now'),
    evalRun
      ? check('eval_median', `The evaluation's median edit distance is at most ${fixed(threshold)}`, evalRun.medianEditDistance <= threshold, `It was ${fixed(evalRun.medianEditDistance)}.`)
      : missing('eval_median', `The evaluation's median edit distance is at most ${fixed(threshold)}`),
    evalRun
      ? check('eval_invented', 'The evaluation found no invented facts', evalRun.inventedFactRate === 0, `Invented-fact rate ${fixed(evalRun.inventedFactRate)} (it must be 0).`)
      : missing('eval_invented', 'The evaluation found no invented facts'),
    check(
      'record_volume',
      `At least ${GATE.recordMinApproved} drafts approved in the last ${GATE.recordWindowDays} days`,
      record.n >= GATE.recordMinApproved,
      `${record.n} approved so far.`,
    ),
    check(
      'record_median',
      `Median edit distance of those drafts is at most ${fixed(threshold)}`,
      record.median !== null && record.median <= threshold,
      record.median === null ? 'No approved drafts yet.' : `It is ${fixed(record.median)} over ${record.n} drafts.`,
    ),
    check(
      'record_p75',
      `75th percentile of those drafts is at most ${fixed(GATE.maxP75)}`,
      record.p75 !== null && record.p75 <= GATE.maxP75,
      record.p75 === null ? 'No approved drafts yet.' : `It is ${fixed(record.p75)}: a quarter of your drafts were edited at least this much.`,
    ),
  ];
  return { eligible: checks.every((item) => item.ok), checks };
}

export async function loadGateFacts(db: DbOrTx, now: Date): Promise<GateFacts> {
  const [latest] = await db.select().from(evalRuns).orderBy(desc(evalRuns.createdAt)).limit(1);
  const [activeGuide] = await db.select({ version: styleGuides.version }).from(styleGuides).where(eq(styleGuides.isActive, true)).limit(1);
  const record = await editDistanceSummary(db, new Date(now.getTime() - GATE.recordWindowDays * DAY_MS), now);
  return {
    now,
    threshold: getEnv().AUTOPILOT_MAX_EDIT_DISTANCE,
    active: { promptVersion: DRAFT_PROMPT_VERSION, model: chatModelId('draft'), styleGuideVersion: activeGuide?.version ?? null },
    latestEval: latest
      ? {
          createdAt: latest.createdAt,
          sampleSize: latest.sampleSize,
          medianEditDistance: latest.medianEditDistance,
          inventedFactRate: latest.inventedFactRate,
          promptVersion: latest.promptVersion,
          model: latest.model,
          styleGuideVersion: latest.styleGuideVersion,
        }
      : null,
    record: { n: record.n, median: record.median, p75: record.p75 },
  };
}

/** The gate as of `now`, with every check and its numbers. */
export async function getEligibility(db: DbOrTx, now: Date = new Date()): Promise<Eligibility> {
  return evaluateGate(await loadGateFacts(db, now));
}
