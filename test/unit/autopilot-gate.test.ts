import { describe, expect, it } from 'vitest';
import { GATE, GATE_CHECK_IDS, type GateFacts, type LatestEval, evaluateGate } from '@/lib/autopilot/eligibility';

const NOW = new Date('2026-10-05T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const goodEval = (): LatestEval => ({
  createdAt: new Date(NOW.getTime() - 3 * DAY),
  sampleSize: 50,
  medianEditDistance: 0.2,
  inventedFactRate: 0,
  promptVersion: 'draft-v1',
  model: 'openai/gpt-oss-120b',
  styleGuideVersion: 4,
});

/** Facts that pass every check. Each test changes one thing. */
function good(): GateFacts {
  return {
    now: NOW,
    threshold: 0.3,
    active: { promptVersion: 'draft-v1', model: 'openai/gpt-oss-120b', styleGuideVersion: 4 },
    latestEval: goodEval(),
    record: { n: 200, median: 0.25, p75: 0.45 },
  };
}

function withChange(change: (facts: GateFacts) => void): GateFacts {
  const facts = good();
  change(facts);
  return facts;
}

const failing = (facts: GateFacts) => evaluateGate(facts).checks.filter((check) => !check.ok).map((check) => check.id);

describe('the eligibility gate (spec 10.1, D-092)', () => {
  it('passes only when all nine checks pass, and has exactly those nine', () => {
    const result = evaluateGate(good());
    expect(result.eligible).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([...GATE_CHECK_IDS]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  const cases: Array<[string, (facts: GateFacts) => void, string[]]> = [
    ['no evaluation at all (every evaluation check fails and says what to run)', (f) => (f.latestEval = null), ['eval_exists', 'eval_fresh', 'eval_samples', 'eval_current', 'eval_median', 'eval_invented']],
    ['an evaluation older than 30 days', (f) => ((f.latestEval as LatestEval).createdAt = new Date(NOW.getTime() - 31 * DAY)), ['eval_fresh']],
    ['an evaluation with fewer than 50 samples', (f) => ((f.latestEval as LatestEval).sampleSize = 49), ['eval_samples']],
    ['an evaluation of another prompt version', (f) => ((f.latestEval as LatestEval).promptVersion = 'draft-v0'), ['eval_current']],
    ['an evaluation of another model', (f) => ((f.latestEval as LatestEval).model = 'some/other-model'), ['eval_current']],
    ['an evaluation of another style guide', (f) => ((f.latestEval as LatestEval).styleGuideVersion = 3), ['eval_current']],
    ['an evaluation with no style guide while one is active', (f) => ((f.latestEval as LatestEval).styleGuideVersion = null), ['eval_current']],
    ['a style guide activated after the evaluation', (f) => (f.active.styleGuideVersion = 5), ['eval_current']],
    ['an evaluation median above the threshold', (f) => ((f.latestEval as LatestEval).medianEditDistance = 0.31), ['eval_median']],
    ['an invented fact in the evaluation', (f) => ((f.latestEval as LatestEval).inventedFactRate = 0.02), ['eval_invented']],
    ['fewer than 200 approved drafts', (f) => (f.record = { n: 199, median: 0.25, p75: 0.45 }), ['record_volume']],
    ['a production median above the threshold', (f) => (f.record = { n: 200, median: 0.31, p75: 0.45 }), ['record_median']],
    ['a production 75th percentile above 0.50', (f) => (f.record = { n: 200, median: 0.25, p75: 0.51 }), ['record_p75']],
    ['no approved drafts at all', (f) => (f.record = { n: 0, median: null, p75: null }), ['record_volume', 'record_median', 'record_p75']],
  ];

  it.each(cases)('fails on %s', (_name, change, expected) => {
    const facts = withChange(change);
    expect(failing(facts)).toEqual(expected);
    expect(evaluateGate(facts).eligible).toBe(false);
  });

  it('is inclusive at the limits: exactly the threshold, 50 samples, 30 days old, 200 drafts and a p75 of 0.50 pass', () => {
    const facts = withChange((f) => {
      f.latestEval = { ...goodEval(), createdAt: new Date(NOW.getTime() - 30 * DAY), sampleSize: GATE.evalMinSamples, medianEditDistance: 0.3 };
      f.record = { n: GATE.recordMinApproved, median: 0.3, p75: GATE.maxP75 };
    });
    expect(failing(facts)).toEqual([]);
  });

  it('uses the configured threshold, not a built-in one', () => {
    const strict = withChange((f) => (f.threshold = 0.2));
    expect(failing(strict)).toEqual(['record_median']);
    const lax = withChange((f) => { f.threshold = 0.6; f.latestEval = { ...goodEval(), medianEditDistance: 0.55 }; f.record = { n: 200, median: 0.55, p75: 0.45 }; });
    expect(failing(lax)).toEqual([]);
  });

  it('shows the numbers behind each check, so the owner can see how far away they are', () => {
    const facts = withChange((f) => {
      f.record = { n: 137, median: 0.41, p75: 0.62 };
      (f.latestEval as LatestEval).sampleSize = 30;
    });
    const detail = (id: string) => evaluateGate(facts).checks.find((check) => check.id === id)?.detail ?? '';
    expect(detail('record_volume')).toContain('137');
    expect(detail('record_median')).toContain('0.41');
    expect(detail('record_p75')).toContain('0.62');
    expect(detail('eval_samples')).toContain('30');
    expect(detail('eval_fresh')).toContain('3 days');
    expect(detail('eval_current')).toContain('draft-v1');
  });
});
