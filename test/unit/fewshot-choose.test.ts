import { describe, expect, it } from 'vitest';
import { type FewShotExample, chooseExamples } from '@/lib/ai/fewshot';

let n = 0;
const ex = (over: Partial<FewShotExample> & { conv?: string; days?: number } = {}): FewShotExample => {
  n += 1;
  return {
    replyMessageId: over.replyMessageId ?? `r${n}`,
    conversationId: over.conversationId ?? over.conv ?? `c${n}`,
    stage: over.stage ?? 'mid',
    customerText: over.customerText === undefined ? `customer ${n}` : over.customerText,
    reply: over.reply ?? `reply ${n}`,
    occurredAt: over.occurredAt ?? new Date(Date.UTC(2026, 0, 1) - (over.days ?? n) * 86_400_000),
    rank: over.rank ?? 0,
  };
};

describe('chooseExamples', () => {
  it('takes up to 3 of the same stage first, even when other stages rank higher', () => {
    const pool = [ex({ stage: 'mid', rank: 0.9 }), ex({ stage: 'mid', rank: 0.8 }), ex({ stage: 'mid', rank: 0.7 }), ex({ stage: 'opening', rank: 0.1 }), ex({ stage: 'opening', rank: 0.2 }), ex({ stage: 'opening', rank: 0.3 }), ex({ stage: 'opening', rank: 0.05 })];
    const chosen = chooseExamples(pool, 'opening');
    expect(chosen.slice(0, 3).map((e) => e.stage)).toEqual(['opening', 'opening', 'opening']);
    expect(chosen.slice(0, 3).map((e) => e.rank)).toEqual([0.3, 0.2, 0.1]);
    // then the best of the rest by rank
    expect(chosen.slice(3, 6).map((e) => e.rank)).toEqual([0.9, 0.8, 0.7]);
  });

  it('fills to 8 and no further, best rank first, ties newest first', () => {
    const pool = Array.from({ length: 20 }, (_, i) => ex({ rank: i % 2 === 0 ? 0.5 : 0.1, days: i + 1 }));
    const chosen = chooseExamples(pool, 'mid');
    expect(chosen).toHaveLength(8);
    expect(chosen.every((e) => e.rank === 0.5)).toBe(true);
    const days = chosen.map((e) => e.occurredAt.getTime());
    expect(days).toEqual([...days].sort((a, b) => b - a));
  });

  it('takes at most 2 from one conversation, however well they rank', () => {
    const pool = [ex({ conv: 'A', rank: 0.9 }), ex({ conv: 'A', rank: 0.8 }), ex({ conv: 'A', rank: 0.7 }), ex({ conv: 'A', rank: 0.6 }), ex({ conv: 'B', rank: 0.1 })];
    const chosen = chooseExamples(pool, 'mid');
    expect(chosen.filter((e) => e.conversationId === 'A')).toHaveLength(2);
    expect(chosen.map((e) => e.conversationId)).toContain('B');
  });

  it('never repeats an identical reply (ignoring case and spacing)', () => {
    const pool = [ex({ reply: 'Ok thanks', rank: 0.9 }), ex({ reply: ' ok   THANKS ', rank: 0.8 }), ex({ reply: 'Sure', rank: 0.1 })];
    expect(chooseExamples(pool, 'mid').map((e) => e.reply)).toEqual(['Ok thanks', 'Sure']);
  });

  it('a pair with no customer text comes after every pair that has one', () => {
    const pool = [ex({ customerText: null, rank: 0, days: 1 }), ex({ rank: 0, days: 50 })];
    const chosen = chooseExamples(pool, 'mid');
    expect(chosen.map((e) => e.customerText === null)).toEqual([false, true]);
  });

  it('respects a smaller limit and quota, and returns nothing for nothing', () => {
    const pool = Array.from({ length: 10 }, () => ex({ stage: 'opening' }));
    expect(chooseExamples(pool, 'opening', { limit: 4 })).toHaveLength(4);
    expect(chooseExamples(pool, 'opening', { limit: 2, sameStageQuota: 5 })).toHaveLength(2);
    expect(chooseExamples([], 'mid')).toEqual([]);
  });
});
