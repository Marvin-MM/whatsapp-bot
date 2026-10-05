import 'server-only';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { generateDraftFromContext, loadDraftContext } from '@/lib/ai/draft';
import { type PairRow, listPairs } from '@/lib/ai/fewshot';
import { localIso, weekdayName } from '@/lib/ai/prompts/format';
import type { Stage } from '@/lib/ai/stages';
import { type Db } from '@/lib/db';
import { evalRuns } from '@/lib/db/schema';
import { editDistance } from '@/lib/metrics/edit-distance';
import { inventedFacts } from '@/lib/metrics/invented-facts';
import { mean, median, pairedMedianDifference, percentile } from '@/lib/metrics/stats';
import { emojiDifference, forbiddenHits, lengthRatio } from '@/lib/metrics/style-metrics';

/**
 * The evaluation harness (spec 9.8): hold out the owner's most recent real (customer -> reply) pairs, have the CURRENT prompt, model and
 * style guide draft each one as if it had arrived then, and measure how far the drafts are from what the owner really wrote. The numbers
 * feed `eval_runs`, which the autopilot gate reads, and a prompt / model / style change ships only if the median edit distance does not
 * regress and the invented-fact rate does not rise (D-049, D-060).
 */

export class EvalError extends Error {
  constructor(readonly code: 'insufficient_data' | 'too_many_failures', message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

export const DEFAULT_SAMPLE_SIZE = 50;
/** Below this there is nothing to measure. */
export const MIN_EVAL_SAMPLES = 10;
/** More than this share of failed generations means the run says nothing about the drafts: it is refused, not averaged over the survivors. */
export const MAX_FAILURE_SHARE = 0.2;

export interface GeneratedDraft {
  reply: string;
  /** Everything the model was given that may license a fact: profile, summary, history, the new messages, the clock. NOT the examples. */
  allowedTexts: string[];
  forbiddenPatterns: string[];
  styleGuideVersion: number | null;
  model: string;
  promptVersion: string;
}

/** Produces one draft for one held-out pair. Injected so tests run without a model. */
export type GenerateFn = (pair: PairRow, holdoutIds: readonly string[]) => Promise<GeneratedDraft>;

export function defaultGenerate(db: Db): GenerateFn {
  return async (pair, holdoutIds) => {
    const loaded = await loadDraftContext(db, { conversationId: pair.conversationId, burstMessageIds: pair.customerMessageIds, now: pair.occurredAt, excludeReplyIds: holdoutIds, useSummary: false });
    const result = await generateDraftFromContext(db, loaded, { purpose: 'eval' });
    const { context } = loaded;
    return {
      reply: result.output.reply,
      allowedTexts: [context.businessProfile, context.ownerName, context.businessName, ...context.history.map((line) => line.text), ...context.burst.map((line) => line.text), `${localIso(context.now, context.ownerTimezone)} ${weekdayName(context.now, context.ownerTimezone)}`],
      forbiddenPatterns: context.styleGuide?.forbiddenPatterns ?? [],
      styleGuideVersion: loaded.styleGuideVersion,
      model: result.model,
      promptVersion: result.promptVersion,
    };
  };
}

export const sampleSchema = z.object({
  replyMessageId: z.string(),
  stage: z.string(),
  customerText: z.string().nullable(),
  real: z.string(),
  draft: z.string().nullable(),
  failure: z.string().nullable(),
  editDistance: z.number().nullable(),
  lengthRatio: z.number().nullable(),
  emojiDifference: z.number().nullable(),
  forbiddenHits: z.array(z.string()),
  inventedFacts: z.array(z.string()),
});
export type EvalSample = z.infer<typeof sampleSchema>;

const aggregateSchema = z.object({
  samples: z.number(),
  failed: z.number(),
  medianEditDistance: z.number(),
  p25EditDistance: z.number(),
  p75EditDistance: z.number(),
  meanLengthRatio: z.number(),
  meanEmojiDifference: z.number(),
  forbiddenHitRate: z.number(),
  inventedFactRate: z.number(),
});

export const resultFileSchema = z.object({
  startedAt: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  styleGuideVersion: z.number().nullable(),
  aggregate: aggregateSchema,
  samples: z.array(sampleSchema),
});
export type EvalResultFile = z.infer<typeof resultFileSchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;

export function aggregate(samples: readonly EvalSample[]): Aggregate {
  const ok = samples.filter((sample) => sample.draft !== null && sample.editDistance !== null);
  const distances = ok.map((sample) => sample.editDistance ?? 0);
  const rate = (predicate: (sample: EvalSample) => boolean) => (ok.length === 0 ? Number.NaN : ok.filter(predicate).length / ok.length);
  return {
    samples: ok.length,
    failed: samples.length - ok.length,
    medianEditDistance: median(distances),
    p25EditDistance: percentile(distances, 0.25),
    p75EditDistance: percentile(distances, 0.75),
    meanLengthRatio: mean(ok.map((sample) => sample.lengthRatio ?? 0)),
    meanEmojiDifference: mean(ok.map((sample) => sample.emojiDifference ?? 0)),
    forbiddenHitRate: rate((sample) => sample.forbiddenHits.length > 0),
    inventedFactRate: rate((sample) => sample.inventedFacts.length > 0),
  };
}

export interface Comparison {
  previousFile: string;
  paired: number;
  medianDelta: number;
  low: number;
  high: number;
  inventedRateDelta: number;
  /** The shipping rule (spec 9.8): median edit distance must not regress (a regression is a rise whose interval excludes zero) and the invented-fact rate must not increase. */
  verdict: 'ok' | 'regressed';
  reasons: string[];
}

export function compare(current: EvalResultFile, previous: EvalResultFile, previousFile: string): Comparison {
  const earlier = new Map(previous.samples.filter((s) => s.editDistance !== null).map((s) => [s.replyMessageId, s.editDistance ?? 0]));
  const pairs = current.samples.filter((s) => s.editDistance !== null && earlier.has(s.replyMessageId));
  const diff = pairedMedianDifference(pairs.map((s) => s.editDistance ?? 0), pairs.map((s) => earlier.get(s.replyMessageId) ?? 0));
  const inventedRateDelta = current.aggregate.inventedFactRate - previous.aggregate.inventedFactRate;
  const reasons: string[] = [];
  if (diff.n > 0 && diff.medianDelta > 0 && diff.low > 0) reasons.push(`median edit distance rose by ${diff.medianDelta.toFixed(3)} (95% interval ${diff.low.toFixed(3)} to ${diff.high.toFixed(3)}, excludes 0)`);
  if (inventedRateDelta > 1e-9) reasons.push(`invented-fact rate rose from ${(previous.aggregate.inventedFactRate * 100).toFixed(1)}% to ${(current.aggregate.inventedFactRate * 100).toFixed(1)}%`);
  return { previousFile, paired: diff.n, medianDelta: diff.medianDelta, low: diff.low, high: diff.high, inventedRateDelta, verdict: reasons.length === 0 ? 'ok' : 'regressed', reasons };
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

function previousResult(outDir: string, currentName: string): { file: string; result: EvalResultFile } | null {
  let names: string[] = [];
  try {
    names = readdirSync(outDir).filter((name) => /^\d{8}-\d{6}\.json$/.test(name) && name < currentName).sort();
  } catch {
    return null;
  }
  for (const name of names.reverse()) {
    try {
      const parsed = resultFileSchema.safeParse(JSON.parse(readFileSync(join(outDir, name), 'utf8')));
      if (parsed.success) return { file: name, result: parsed.data };
    } catch {
      // an unreadable older file is skipped, never fatal
    }
  }
  return null;
}

const pct = (value: number) => (Number.isNaN(value) ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const num = (value: number) => (Number.isNaN(value) ? 'n/a' : value.toFixed(3));

function pickForDisplay(samples: readonly EvalSample[], count: number): EvalSample[] {
  const ok = samples.filter((s) => s.draft !== null).sort((a, b) => (a.editDistance ?? 0) - (b.editDistance ?? 0));
  if (ok.length <= count) return ok;
  return Array.from({ length: count }, (_, i) => ok[Math.round((i * (ok.length - 1)) / (count - 1))]).filter((s): s is EvalSample => s !== undefined);
}

function fence(text: string): string {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}

export function renderReport(result: EvalResultFile, comparison: Comparison | null, warnings: readonly string[]): string {
  const a = result.aggregate;
  const lines = [
    `# Draft evaluation ${result.startedAt}`,
    '',
    `Prompt \`${result.promptVersion}\` - model \`${result.model}\` - style guide ${result.styleGuideVersion === null ? 'none (cold start)' : `v${result.styleGuideVersion}`}`,
    '',
    'This file contains real customer messages and your replies. It is local (git-ignored): do not share it.',
    '',
    ...warnings.map((w) => `**Warning:** ${w}`),
    '',
    '## Aggregates',
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Samples drafted / failed | ${a.samples} / ${a.failed} |`,
    `| Median edit distance (0 = identical to what you wrote) | ${num(a.medianEditDistance)} |`,
    `| 25th / 75th percentile | ${num(a.p25EditDistance)} / ${num(a.p75EditDistance)} |`,
    `| Mean length ratio (draft / real) | ${num(a.meanLengthRatio)} |`,
    `| Mean emoji-count difference | ${num(a.meanEmojiDifference)} |`,
    `| Drafts using a forbidden pattern | ${pct(a.forbiddenHitRate)} |`,
    `| Drafts with an invented fact | ${pct(a.inventedFactRate)} |`,
    '',
  ];
  if (comparison) {
    lines.push(
      `## Against the previous run (${comparison.previousFile})`,
      '',
      `${comparison.paired} samples paired. Median change in edit distance: ${comparison.medianDelta >= 0 ? '+' : ''}${num(comparison.medianDelta)} (95% interval ${num(comparison.low)} to ${num(comparison.high)}; negative is better). Invented-fact rate change: ${comparison.inventedRateDelta >= 0 ? '+' : ''}${(comparison.inventedRateDelta * 100).toFixed(1)} points.`,
      '',
      comparison.verdict === 'ok' ? '**Verdict: nothing regressed.** (Spec 9.8: a change ships only if the median edit distance does not regress and the invented-fact rate does not increase.)' : `**Verdict: REGRESSED. Do not ship this change.** ${comparison.reasons.join('; ')}.`,
      '',
    );
  } else lines.push('## Against the previous run', '', 'There is no earlier run to compare with: this is the baseline.', '');

  const invented = result.samples.filter((s) => s.inventedFacts.length > 0);
  if (invented.length > 0) {
    lines.push('## Invented facts found', '', 'Each is a number, amount or calendar word in a draft that was not in the profile, the conversation or the clock. (A regex cannot read: numbers written as words and wrong names are NOT detected.)', '');
    for (const sample of invented) lines.push(`- \`${sample.replyMessageId}\`: ${sample.inventedFacts.join(', ')}`);
    lines.push('');
  }
  const failures = result.samples.filter((s) => s.failure !== null);
  if (failures.length > 0) {
    lines.push('## Samples that could not be drafted', '', ...failures.map((s) => `- \`${s.replyMessageId}\`: ${s.failure}`), '');
  }

  lines.push('## Side by side (spread from closest to furthest)', '');
  for (const sample of pickForDisplay(result.samples, 15)) {
    lines.push(`### ${sample.stage} - edit distance ${num(sample.editDistance ?? Number.NaN)}${sample.inventedFacts.length ? ' - INVENTED: ' + sample.inventedFacts.join(', ') : ''}${sample.forbiddenHits.length ? ' - FORBIDDEN: ' + sample.forbiddenHits.join(', ') : ''}`, '');
    if (sample.customerText) lines.push('**Customer**', fence(sample.customerText), '');
    lines.push('**You wrote**', fence(sample.real), '', '**Draft**', fence(sample.draft ?? ''), '');
  }
  return lines.join('\n');
}

export interface EvalOptions {
  now?: Date;
  sampleSize?: number;
  outDir: string;
  generate?: GenerateFn;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface EvalOutcome {
  jsonPath: string;
  reportPath: string;
  result: EvalResultFile;
  comparison: Comparison | null;
  warnings: string[];
  evalRunId: string;
}

export async function runEval(db: Db, options: EvalOptions): Promise<EvalOutcome> {
  const now = options.now ?? new Date();
  const size = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const pairs = await listPairs(db, { now, limit: size });
  if (pairs.length < MIN_EVAL_SAMPLES) {
    throw new EvalError('insufficient_data', `Only ${pairs.length} of your replies have a customer message before them; at least ${MIN_EVAL_SAMPLES} are needed (50 for the autopilot gate). Import more chats first.`);
  }
  const warnings: string[] = [];
  if (pairs.length < DEFAULT_SAMPLE_SIZE) warnings.push(`Only ${pairs.length} samples (the autopilot gate needs at least ${DEFAULT_SAMPLE_SIZE}). This run is informative, not usable for the gate.`);

  const holdoutIds = pairs.map((pair) => pair.replyMessageId);
  const generate = options.generate ?? defaultGenerate(db);
  const results: Array<EvalSample | undefined> = new Array<EvalSample | undefined>(pairs.length).fill(undefined);
  let meta = { model: 'unknown', promptVersion: 'unknown', styleGuideVersion: null as number | null };
  let done = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const pair = pairs[index];
      if (!pair) return;
      const base = { replyMessageId: pair.replyMessageId, stage: pair.stage as Stage, customerText: pair.customerText, real: pair.reply };
      try {
        const draft = await generate(pair, holdoutIds);
        meta = { model: draft.model, promptVersion: draft.promptVersion, styleGuideVersion: draft.styleGuideVersion };
        results[index] = {
          ...base,
          draft: draft.reply,
          failure: null,
          editDistance: editDistance(draft.reply, pair.reply),
          lengthRatio: lengthRatio(draft.reply, pair.reply),
          emojiDifference: emojiDifference(draft.reply, pair.reply),
          forbiddenHits: forbiddenHits(draft.reply, draft.forbiddenPatterns),
          inventedFacts: inventedFacts(draft.reply, draft.allowedTexts),
        };
      } catch (error) {
        // The name of the failure only: never the text of a customer message.
        results[index] = { ...base, draft: null, failure: error instanceof Error ? error.name : 'error', editDistance: null, lengthRatio: null, emojiDifference: null, forbiddenHits: [], inventedFacts: [] };
      }
      done += 1;
      options.onProgress?.(done, pairs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 3) }, worker));

  const samples = results.filter((sample): sample is EvalSample => sample !== undefined);
  const failed = samples.filter((sample) => sample.draft === null).length;
  if (failed / samples.length > MAX_FAILURE_SHARE) {
    throw new EvalError('too_many_failures', `${failed} of ${samples.length} drafts failed (more than ${MAX_FAILURE_SHARE * 100}%): the run says nothing about the drafts. Check the model and the key, then run again.`);
  }

  const result: EvalResultFile = { startedAt: now.toISOString(), ...meta, aggregate: aggregate(samples), samples };
  mkdirSync(options.outDir, { recursive: true });
  const name = stamp(now);
  const jsonPath = join(options.outDir, `${name}.json`);
  const reportPath = join(options.outDir, `${name}.md`);
  const previous = previousResult(options.outDir, `${name}.json`);
  const comparison = previous ? compare(result, previous.result, previous.file) : null;
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  writeFileSync(reportPath, renderReport(result, comparison, warnings));

  const [row] = await db
    .insert(evalRuns)
    .values({
      promptVersion: result.promptVersion,
      model: result.model,
      styleGuideVersion: result.styleGuideVersion,
      sampleSize: result.aggregate.samples,
      medianEditDistance: result.aggregate.medianEditDistance,
      inventedFactRate: result.aggregate.inventedFactRate,
      forbiddenHitRate: result.aggregate.forbiddenHitRate,
      reportPath: `eval/results/${name}.md`,
    })
    .returning({ id: evalRuns.id });
  if (!row) throw new Error('eval_runs insert returned nothing');
  return { jsonPath, reportPath, result, comparison, warnings, evalRunId: row.id };
}
