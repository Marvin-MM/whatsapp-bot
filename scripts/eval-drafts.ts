import { parseArgs } from 'node:util';
import { listPairs } from '@/lib/ai/fewshot';
import { closeDb, getDb } from '@/lib/db';
import { DEFAULT_SAMPLE_SIZE, EvalError, runEval } from '@/lib/eval/run-eval';

const USAGE = `Usage: pnpm eval:drafts [options]

Holds out your ${DEFAULT_SAMPLE_SIZE} most recent real replies, has the CURRENT prompt, model and style guide draft each one, and measures how far the
drafts are from what you wrote. Writes eval/results/<time>.md (read this) and .json, and records the run for the autopilot gate.
Needs GROQ_API_KEY and an imported or accumulated history. Customer messages are sent to Groq, as for any draft.

Options:
  --samples <n>   How many recent replies to hold out (default ${DEFAULT_SAMPLE_SIZE}; the autopilot gate needs at least ${DEFAULT_SAMPLE_SIZE})
  --out <dir>     Where to write the report (default eval/results)
  --dry-run       List what would be held out and stop (no model calls, nothing written)
  -h, --help      Show this help
`;

const { values } = parseArgs({
  options: {
    samples: { type: 'string' },
    out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

async function main(): Promise<void> {
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const samples = values.samples === undefined ? DEFAULT_SAMPLE_SIZE : Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > 500) throw new Error('--samples must be a whole number between 1 and 500.');
  const db = getDb();

  if (values['dry-run']) {
    const pairs = await listPairs(db, { now: new Date(), limit: samples });
    process.stdout.write(`${pairs.length} replies would be held out (newest ${pairs[0]?.occurredAt.toISOString() ?? 'n/a'}, oldest ${pairs.at(-1)?.occurredAt.toISOString() ?? 'n/a'}). Nothing was written.\n`);
    return;
  }

  const outcome = await runEval(db, {
    sampleSize: samples,
    outDir: values.out ?? 'eval/results',
    onProgress: (done, total) => process.stdout.write(`\rdrafting ${done}/${total}`),
  });
  const a = outcome.result.aggregate;
  process.stdout.write(
    `\n\nSamples ${a.samples} (failed ${a.failed}). Median edit distance ${a.medianEditDistance.toFixed(3)} (p25 ${a.p25EditDistance.toFixed(3)}, p75 ${a.p75EditDistance.toFixed(3)}). Invented-fact rate ${(a.inventedFactRate * 100).toFixed(1)}%. Forbidden-pattern rate ${(a.forbiddenHitRate * 100).toFixed(1)}%.\n`,
  );
  for (const warning of outcome.warnings) process.stdout.write(`Warning: ${warning}\n`);
  if (outcome.comparison) {
    process.stdout.write(outcome.comparison.verdict === 'ok' ? 'Against the previous run: nothing regressed.\n' : `REGRESSED against the previous run: ${outcome.comparison.reasons.join('; ')}. Do not ship this change.\n`);
    if (outcome.comparison.verdict === 'regressed') process.exitCode = 2;
  } else process.stdout.write('No earlier run: this is the baseline. Record it in DECISIONS.md.\n');
  process.stdout.write(`Report: ${outcome.reportPath}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof EvalError || error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
