import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetModelProvider } from '@/lib/ai/models';
import { resetStrictCache } from '@/lib/ai/run';
import { getDb } from '@/lib/db';
import { EvalError, type GenerateFn, type GeneratedDraft, MIN_EVAL_SAMPLES, aggregate, defaultGenerate, runEval } from '@/lib/eval/run-eval';
import { chatCompletion, stubGroq } from '../helpers/groq';
import { count, seedContact, seedConversation, seedMessage, setupIngestHarness } from '../helpers/ingest';

const h = setupIngestHarness();
const sql = () => h.admin();

const NOW = new Date('2026-10-05T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

beforeEach(() => {
  resetStrictCache();
  resetModelProvider();
});
afterEach(() => vi.unstubAllGlobals());

const outDir = () => mkdtempSync(join(tmpdir(), 'eval-test-'));

/** `n` exchanges, newest reply `1 day` before NOW, each in its own segment. Customer "q{i}", real reply "real {i}". */
async function seedPairs(n: number): Promise<string[]> {
  const contact = await seedContact(sql(), { phone: '+256700123456', name: 'Amina' });
  const conv = await seedConversation(sql(), contact, { status: 'resolved' });
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const base = NOW.getTime() - (n - i + 1) * 2 * DAY;
    await seedMessage(sql(), conv, { direction: 'inbound', content: `q${i} how much for item ${i}`, occurredAt: new Date(base) });
    ids.push(await seedMessage(sql(), conv, { direction: 'outbound', content: `real ${i}`, provenance: 'imported', occurredAt: new Date(base + MIN) }));
  }
  return ids;
}

const draft = (reply: string, extra: Partial<GeneratedDraft> = {}): GeneratedDraft => ({
  reply,
  // the digits 0-59 stand for the numbers that appear in the seeded conversation, so only the numbers a test adds are "invented"
  allowedTexts: ['profile: dress 50,000', Array.from({ length: 60 }, (_, i) => i).join(' ')],
  forbiddenPatterns: ['certainly!'],
  styleGuideVersion: 2,
  model: 'm-test',
  promptVersion: 'draft-vT',
  ...extra,
});

describe('runEval', () => {
  it('holds out the newest pairs, excludes ALL of them from retrieval, and computes the aggregates (hand-checked)', async () => {
    await seedPairs(12);
    const seenHoldout: string[][] = [];
    const replies = ['real 11', 'real 10', 'rXal 9', 'real 8', 'totally different', 'real 6', 'real 5', 'real 4', 'real 3', 'real 2', 'real 1', 'real 0'];
    const generate: GenerateFn = async (pair, holdoutIds) => {
      seenHoldout.push([...holdoutIds]);
      const index = 11 - Number(/real (\d+)/.exec(pair.reply)?.[1]);
      return draft(replies[index] ?? '');
    };
    const dir = outDir();
    const outcome = await runEval(getDb(), { now: NOW, sampleSize: 12, outDir: dir, generate });

    const a = outcome.result.aggregate;
    expect(a.samples).toBe(12);
    expect(a.failed).toBe(0);
    // one draft differs by one character from "real 9" (1/6), one is "totally different" vs "real 7" (distance computed below), the rest identical
    expect(outcome.result.samples.filter((s) => s.editDistance === 0)).toHaveLength(10);
    expect(outcome.result.samples.find((s) => s.draft === 'rXal 9')?.editDistance).toBeCloseTo(1 / 6, 10);
    expect(a.medianEditDistance).toBe(0);
    expect(outcome.result.samples.find((s) => s.draft === 'totally different')?.editDistance).toBeGreaterThan(0.8);
    expect(a.meanLengthRatio).toBeGreaterThan(0.9);
    expect(a.forbiddenHitRate).toBe(0);
    expect(a.inventedFactRate).toBe(0);

    // every call was told the full held-out list: the replies being predicted are never examples
    expect(seenHoldout).toHaveLength(12);
    const holdout = new Set(seenHoldout[0]);
    expect(holdout.size).toBe(12);
    expect(seenHoldout.every((list) => list.length === 12 && list.every((id) => holdout.has(id)))).toBe(true);
  });

  it('the most recent pairs are the ones held out, and `sampleSize` limits them', async () => {
    await seedPairs(15);
    const seen: string[] = [];
    await runEval(getDb(), { now: NOW, sampleSize: 10, outDir: outDir(), generate: async (pair) => (seen.push(pair.reply), draft(pair.reply)) });
    expect(seen.sort()).toEqual(['real 10', 'real 11', 'real 12', 'real 13', 'real 14', 'real 5', 'real 6', 'real 7', 'real 8', 'real 9'].sort());
  });

  it('counts a draft with a number the model was not given as an invented fact, and one with a forbidden phrase', async () => {
    await seedPairs(10);
    const generate: GenerateFn = async (pair) => {
      if (pair.reply === 'real 9') return draft('It is 45,000 only dear');
      if (pair.reply === 'real 8') return draft('Certainly! it is 50k');
      if (pair.reply === 'real 7') return draft('It is [[price?]] dear');
      return draft('50k dear');
    };
    const { result } = await runEval(getDb(), { now: NOW, sampleSize: 10, outDir: outDir(), generate });
    expect(result.samples.find((s) => s.real === 'real 9')?.inventedFacts).toEqual(['45000']);
    expect(result.samples.find((s) => s.real === 'real 8')?.forbiddenHits).toEqual(['certainly!']);
    expect(result.samples.find((s) => s.real === 'real 7')?.inventedFacts).toEqual([]);
    expect(result.aggregate.inventedFactRate).toBeCloseTo(1 / 10, 10);
    expect(result.aggregate.forbiddenHitRate).toBeCloseTo(1 / 10, 10);
  });

  it('writes a readable report and a JSON file, and records the run for the autopilot gate', async () => {
    await seedPairs(11);
    const dir = outDir();
    const outcome = await runEval(getDb(), { now: NOW, sampleSize: 11, outDir: dir, generate: async (pair) => draft(pair.reply.replace('real', 'Real')) });

    expect(readdirSync(dir).sort()).toEqual(['20261005-120000.json', '20261005-120000.md']);
    const report = readFileSync(outcome.reportPath, 'utf8');
    expect(report).toContain('# Draft evaluation 2026-10-05T12:00:00.000Z');
    expect(report).toContain('Prompt `draft-vT` - model `m-test` - style guide v2');
    expect(report).toContain('| Median edit distance');
    expect(report).toContain('this is the baseline');
    expect(report).toContain('**Warning:** Only 11 samples (the autopilot gate needs at least 50)');
    expect(report).toContain('**You wrote**');
    expect(report).toContain('git-ignored');

    const [row] = await sql()<{ prompt_version: string; model: string; style_guide_version: number; sample_size: number; median_edit_distance: number; invented_fact_rate: number; forbidden_hit_rate: number; report_path: string }[]>`SELECT * FROM eval_runs`;
    expect(row).toMatchObject({ prompt_version: 'draft-vT', model: 'm-test', style_guide_version: 2, sample_size: 11, invented_fact_rate: 0, forbidden_hit_rate: 0, report_path: 'eval/results/20261005-120000.md' });
    expect(row?.median_edit_distance).toBeCloseTo(1 / 6, 5);
  });

  it('refuses a run with too few pairs, and one where more than 20% of drafts fail: nothing is written or recorded', async () => {
    await seedPairs(MIN_EVAL_SAMPLES - 1);
    const dir = outDir();
    await expect(runEval(getDb(), { now: NOW, outDir: dir, generate: async (p) => draft(p.reply) })).rejects.toMatchObject({ code: 'insufficient_data' });

    await seedMessage(sql(), (await sql()<{ id: string }[]>`SELECT id FROM conversations LIMIT 1`)[0]?.id ?? '', { direction: 'inbound', content: 'more', occurredAt: new Date(NOW.getTime() - 3 * MIN) });
    await seedMessage(sql(), (await sql()<{ id: string }[]>`SELECT id FROM conversations LIMIT 1`)[0]?.id ?? '', { direction: 'outbound', content: 'real extra', provenance: 'imported', occurredAt: new Date(NOW.getTime() - 2 * MIN) });
    let calls = 0;
    const flaky: GenerateFn = async (pair) => {
      calls += 1;
      if (calls <= 3) throw new Error('provider down');
      return draft(pair.reply);
    };
    const failure = await runEval(getDb(), { now: NOW, outDir: dir, generate: flaky, concurrency: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EvalError);
    expect((failure as EvalError).code).toBe('too_many_failures');
    expect(readdirSync(dir)).toEqual([]);
    expect(await count(sql(), 'eval_runs')).toBe(0);
  });

  it('rates are over the drafts that were made, not over the failures too (1 invented fact in 19 drafts)', async () => {
    await seedPairs(20);
    let calls = 0;
    const generate: GenerateFn = async (pair) => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return draft(pair.reply === 'real 5' ? 'real 5 and 77' : pair.reply);
    };
    const { result } = await runEval(getDb(), { now: NOW, sampleSize: 20, outDir: outDir(), generate, concurrency: 1 });
    expect(result.aggregate.samples).toBe(19);
    expect(result.aggregate.inventedFactRate).toBeCloseTo(1 / 19, 10);
  });

  it('tolerates a few failed drafts: they are reported by NAME and left out of the numbers', async () => {
    await seedPairs(20);
    let calls = 0;
    const generate: GenerateFn = async (pair) => {
      calls += 1;
      if (calls === 2) throw new RangeError('boom');
      return draft(pair.reply);
    };
    const outcome = await runEval(getDb(), { now: NOW, sampleSize: 20, outDir: outDir(), generate, concurrency: 1 });
    expect(outcome.result.aggregate).toMatchObject({ samples: 19, failed: 1 });
    expect(readFileSync(outcome.reportPath, 'utf8')).toContain('RangeError');
    expect(readFileSync(outcome.reportPath, 'utf8')).not.toContain('boom');
    expect((await sql()<{ sample_size: number }[]>`SELECT sample_size FROM eval_runs`)[0]?.sample_size).toBe(19);
  });
});

describe('comparing with the previous run (spec 9.8: a change ships only if nothing regressed)', () => {
  async function twoRuns(first: (reply: string) => string, second: (reply: string) => string, secondOpts: Partial<GeneratedDraft> = {}) {
    await seedPairs(30);
    const dir = outDir();
    await runEval(getDb(), { now: NOW, sampleSize: 30, outDir: dir, generate: async (p) => draft(first(p.reply)) });
    return runEval(getDb(), { now: new Date(NOW.getTime() + 60_000), sampleSize: 30, outDir: dir, generate: async (p) => draft(second(p.reply), secondOpts) });
  }

  it('a clear improvement is ok and says so', async () => {
    const outcome = await twoRuns((r) => `${r} and a lot of extra words here`, (r) => r);
    expect(outcome.comparison?.verdict).toBe('ok');
    expect(outcome.comparison?.medianDelta).toBeLessThan(0);
    expect(outcome.comparison?.high).toBeLessThan(0);
    expect(readFileSync(outcome.reportPath, 'utf8')).toContain('Verdict: nothing regressed');
  });

  it('a clear regression in median edit distance is REGRESSED, with the interval', async () => {
    const outcome = await twoRuns((r) => r, (r) => `${r} and a lot of extra words here`);
    expect(outcome.comparison?.verdict).toBe('regressed');
    expect(outcome.comparison?.reasons.join(' ')).toMatch(/median edit distance rose/);
    expect(outcome.comparison?.low).toBeGreaterThan(0);
    expect(readFileSync(outcome.reportPath, 'utf8')).toContain('REGRESSED. Do not ship this change');
  });

  it('noise around zero is not a regression', async () => {
    const outcome = await twoRuns((r) => r, (r) => (Number(/\d+/.exec(r)?.[0]) % 2 === 0 ? `${r}!` : r));
    expect(outcome.comparison?.verdict).toBe('ok');
  });

  it('ANY rise in the invented-fact rate is a regression, even when the edit distance is unchanged', async () => {
    await seedPairs(30);
    const dir = outDir();
    await runEval(getDb(), { now: NOW, sampleSize: 30, outDir: dir, generate: async (p) => draft(p.reply) });
    const outcome = await runEval(getDb(), { now: new Date(NOW.getTime() + 60_000), sampleSize: 30, outDir: dir, generate: async (p) => draft(p.reply === 'real 29' ? 'real 29 99' : p.reply) });
    expect(outcome.comparison?.verdict).toBe('regressed');
    expect(outcome.comparison?.reasons.join(' ')).toMatch(/invented-fact rate rose from 0.0% to 3.3%/);
  });

  it('skips an unreadable older file instead of failing, and compares with the newest readable one', async () => {
    await seedPairs(12);
    const dir = outDir();
    writeFileSync(join(dir, '20250101-000000.json'), '{not json');
    await runEval(getDb(), { now: NOW, sampleSize: 12, outDir: dir, generate: async (p) => draft(p.reply) });
    writeFileSync(join(dir, '20261005-120030.json'), '{"startedAt":"x"}');
    const outcome = await runEval(getDb(), { now: new Date(NOW.getTime() + 60_000), sampleSize: 12, outDir: dir, generate: async (p) => draft(p.reply) });
    expect(outcome.comparison?.previousFile).toBe('20261005-120000.json');
  });
});

describe('aggregate', () => {
  it('ignores failed samples and is NaN, not a crash, for no samples', () => {
    expect(Number.isNaN(aggregate([]).medianEditDistance)).toBe(true);
    expect(aggregate([]).samples).toBe(0);
  });
});

describe('defaultGenerate (the real context + model path, model stubbed at the network)', () => {
  it('never shows the model the held-out reply, drafts "as of" the real reply’s time, and logs the call as an eval run', async () => {
    await seedPairs(12);
    await sql()`INSERT INTO settings (id, owner_name, business_name, business_profile) VALUES (1, 'Marvin', 'agent_47', 'Dress: UGX 50,000') ON CONFLICT (id) DO UPDATE SET owner_name = 'Marvin'`;
    // today's summary describes the conversation as it is NOW; a draft made "as of" an old reply must not see it
    await sql()`UPDATE conversations SET summary = 'TODAYS-SUMMARY-MUST-NOT-LEAK'`;
    const { requests } = stubGroq(() => chatCompletion(JSON.stringify({ intent: 'question', analysis: 'a', missingFacts: [], riskFlags: [], noReplyNeeded: false, reply: 'Dress is 50k' })));
    const outcome = await runEval(getDb(), { now: NOW, sampleSize: 10, outDir: outDir(), generate: defaultGenerate(getDb()), concurrency: 1 });

    expect(outcome.result.aggregate.samples).toBe(10);
    expect(outcome.result.model).toBe('test-draft-model');
    expect(outcome.result.promptVersion).toBe('draft-v1');
    expect(requests).toHaveLength(10);

    // the 10 held-out replies are real 2..11; none may appear as an example in any request (real 0 and 1 are not held out and may)
    const heldOut = Array.from({ length: 10 }, (_, i) => `real ${i + 2}`);
    for (const request of requests) {
      const system = String((request.body?.messages as Array<{ content: string }>)[0]?.content);
      const examples = system.slice(system.indexOf('<examples>'));
      for (const reply of heldOut) expect(examples.includes(`<owner>${reply}</owner>`), reply).toBe(false);
    }
    for (const request of requests) expect(JSON.stringify(request.body)).not.toContain('TODAYS-SUMMARY-MUST-NOT-LEAK');
    // each draft is made as of the time of the reply it predicts: <now> differs between requests
    const nows = new Set(requests.map((r) => /<now>(.*?)<\/now>/.exec(String((r.body?.messages as Array<{ content: string }>)[0]?.content))?.[1]));
    expect(nows.size).toBe(10);
    expect(await count(sql(), 'ai_runs', `purpose = 'eval'`)).toBe(10);
    expect(await count(sql(), 'ai_runs', `purpose = 'draft'`)).toBe(0);
    expect(existsSync(outcome.jsonPath)).toBe(true);
  });
});
