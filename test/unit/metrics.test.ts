import { describe, expect, it } from 'vitest';
import { editDistance, levenshtein } from '@/lib/metrics/edit-distance';
import { factTokens, inventedFacts } from '@/lib/metrics/invented-facts';
import { mean, median, pairedMedianDifference, percentile, seededRandom } from '@/lib/metrics/stats';
import { emojiCount, emojiDifference, forbiddenHits, lengthRatio } from '@/lib/metrics/style-metrics';

describe('levenshtein / editDistance', () => {
  it('matches hand-computed distances', () => {
    expect(levenshtein([...'kitten'], [...'sitting'])).toBe(3);
    expect(editDistance('kitten', 'sitting')).toBeCloseTo(3 / 7, 10);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('', 'abc')).toBe(1);
    expect(editDistance('abc', '')).toBe(1);
    expect(editDistance('abc', 'xyz')).toBe(1);
    expect(editDistance('flaw', 'lawn')).toBeCloseTo(2 / 4, 10);
    expect(editDistance('Hello there', 'hello there')).toBeCloseTo(1 / 11, 10);
  });

  it('counts an emoji as ONE edit, not two UTF-16 units', () => {
    expect(editDistance('hi 🙏', 'hi')).toBeCloseTo(2 / 4, 10);
    expect(editDistance('🙏', '🙌')).toBe(1);
    expect(editDistance('ok 👍🏽', 'ok')).toBeCloseTo(3 / 5, 10); // 👍 + skin-tone modifier are two code points
  });

  it('ignores surrounding whitespace and the way an accent is encoded', () => {
    expect(editDistance('  see you  ', 'see you')).toBe(0);
    expect(editDistance('café', 'café')).toBe(0);
    expect(editDistance('a b', 'a  b')).toBeCloseTo(1 / 4, 10);
  });

  it('is symmetric and stays within 0..1', () => {
    const pairs: Array<[string, string]> = [['a', 'bcdef'], ['hello', 'help'], ['', 'x'], ['same', 'same'], ['😀😀', 'ab']];
    for (const [a, b] of pairs) {
      expect(editDistance(a, b)).toBe(editDistance(b, a));
      expect(editDistance(a, b)).toBeGreaterThanOrEqual(0);
      expect(editDistance(a, b)).toBeLessThanOrEqual(1);
    }
  });
});

describe('factTokens / inventedFacts', () => {
  it('reads amounts however they are written: 50k, UGX 50,000, 50 000 and 50000 are the same number', () => {
    for (const text of ['50k', 'UGX 50,000', '50 000', '50000', '50K/=', 'shs 50,000/=']) expect([...factTokens(text)]).toEqual(['50000']);
    expect([...factTokens('2.5m')]).toEqual(['2500000']);
    expect([...factTokens('1,250,000')]).toEqual(['1250000']);
    expect([...factTokens('size 38, 2 pieces')].sort()).toEqual(['2', '38']);
  });

  it('a "5 minutes" is 5, not five million', () => {
    expect([...factTokens('wait 5 minutes')]).toEqual(['5']);
    expect([...factTokens('5m')]).toEqual(['5000000']); // documented: an adjacent m means millions
  });

  it('reads times and ordinals as their numbers, and calendar words case-insensitively', () => {
    expect([...factTokens('at 3pm on Friday, 2nd March')].sort()).toEqual(['2', '3', 'friday', 'march']);
    expect([...factTokens('15:30')].sort()).toEqual(['15', '30']);
  });

  it('ignores list numbering and never counts anything inside a placeholder', () => {
    expect([...factTokens('1. dress\n2) bag')]).toEqual([]);
    expect([...factTokens('The price is [[price of blue dress 50k?]]')]).toEqual([]);
  });

  it('flags a number the model was never given, and accepts the same number written differently', () => {
    const allowed = ['Blue dress: UGX 50,000. Delivery in Kampala is free.', '[10:02] Customer: do you have it in size M?'];
    expect(inventedFacts('Yes, the blue dress is 50k', allowed)).toEqual([]);
    expect(inventedFacts('Yes it is 45,000 only', allowed)).toEqual(['45000']);
    expect(inventedFacts('Yes, size M is available, ready by Friday', allowed)).toEqual(['friday']);
  });

  it('a placeholder is the model saying "I do not know": never a finding', () => {
    expect(inventedFacts('It costs [[price of the blue dress?]], I will confirm [[delivery date 12 Oct?]]', [])).toEqual([]);
  });

  it('finds dates and weekdays the inputs do not contain, and allows the ones they do', () => {
    expect(inventedFacts('See you on Monday 14 October', ['Today is Monday, 5 October 2026'])).toEqual(['14']);
    expect(inventedFacts('See you on Monday', ['<now> Monday'])).toEqual([]);
  });

  it('does not let an example from another conversation license a fact (the caller leaves examples out; this is the contract)', () => {
    expect(inventedFacts('It is 80k', ['(business profile has no prices)'])).toEqual(['80000']);
  });

  it('returns nothing for a reply with no facts at all, and tolerates empty input', () => {
    expect(inventedFacts('Ok dear, see you soon 🙏', [])).toEqual([]);
    expect(inventedFacts('', ['anything'])).toEqual([]);
  });
});

describe('stats', () => {
  it('median and percentiles interpolate between ranks', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 0.75)).toBe(4);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([0, 10], 0.3)).toBe(3);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(mean([1, 2, 3, 6])).toBe(3);
  });

  it('seededRandom is reproducible and spread over [0, 1)', () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const sa = Array.from({ length: 5 }, a);
    expect(sa).toEqual(Array.from({ length: 5 }, b));
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(sa).size).toBe(5);
  });

  it('paired bootstrap: a clear improvement has an interval entirely below zero, no change straddles zero', () => {
    const older = Array.from({ length: 50 }, (_, i) => 0.5 + (i % 5) * 0.02);
    const better = older.map((value) => value - 0.1);
    const clear = pairedMedianDifference(better, older);
    expect(clear.medianDelta).toBeCloseTo(-0.1, 10);
    expect(clear.high).toBeLessThan(0);

    const noisy = older.map((value, i) => value + (i % 2 === 0 ? 0.03 : -0.03));
    const same = pairedMedianDifference(noisy, older);
    expect(same.low).toBeLessThanOrEqual(0);
    expect(same.high).toBeGreaterThanOrEqual(0);
  });

  it('paired bootstrap is reproducible, and an empty comparison is NaN, not a crash', () => {
    const a = [0.1, 0.2, 0.3, 0.4, 0.5];
    const b = [0.2, 0.2, 0.2, 0.2, 0.2];
    expect(pairedMedianDifference(a, b)).toEqual(pairedMedianDifference(a, b));
    expect(Number.isNaN(pairedMedianDifference([], []).medianDelta)).toBe(true);
  });
});

describe('style metrics', () => {
  it('length ratio, emoji counts and differences', () => {
    expect(lengthRatio('hello', 'hello world')).toBeCloseTo(5 / 11, 10);
    expect(lengthRatio('abc', '')).toBe(3);
    expect(emojiCount('thanks 🙏🙏 see you 😀')).toBe(3);
    expect(emojiCount('plain 123 text')).toBe(0);
    expect(emojiDifference('ok 🙏', 'ok')).toBe(1);
    expect(emojiDifference('ok 🙏', 'ok 🙏')).toBe(0);
  });

  it('forbidden patterns are case-insensitive substrings, and blank patterns never match', () => {
    expect(forbiddenHits('Certainly! I will do it', ['certainly!', 'As an AI', ''])).toEqual(['certainly!']);
    expect(forbiddenHits('see you', ['As an AI', '   '])).toEqual([]);
  });
});
