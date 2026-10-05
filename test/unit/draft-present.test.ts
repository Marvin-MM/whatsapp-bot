import { describe, expect, it } from 'vitest';
import { RISK_FLAGS } from '@/lib/ai/schemas';
import { INTENT_LABEL, describeEditRate, findPlaceholders, intentLabel, intentTone, isEdited, riskFlagLabel } from '@/lib/drafts/present';
import { PLACEHOLDER_PATTERN } from '@/lib/send/precheck';
import { draftIntent } from '@/lib/db/schema';

describe('findPlaceholders', () => {
  it('finds every [[placeholder]] with its position, in order', () => {
    const text = 'The [[price]] for the [[colour]] one';
    expect(findPlaceholders(text)).toEqual([
      { text: '[[price]]', start: 4, end: 13 },
      { text: '[[colour]]', start: 22, end: 32 },
    ]);
    for (const match of findPlaceholders(text)) expect(text.slice(match.start, match.end)).toBe(match.text);
  });

  it.each(['plain text', '[single]', '[[unterminated', 'a ]] b [[', ''])('finds nothing in %j', (text) => {
    expect(findPlaceholders(text)).toEqual([]);
  });

  it('agrees with the send pre-check on whether a text is blocked (the card must never enable what the server will refuse)', () => {
    for (const text of ['hello', 'price [[price]]', '[[]]', 'multi\nline [[a b c]] done', '[[one]] [[two]]', 'x [ [y] ] z', '[[with [bracket]]']) {
      expect(findPlaceholders(text).length > 0).toBe(PLACEHOLDER_PATTERN.test(text));
    }
  });

  it('is not poisoned by being called repeatedly (no shared lastIndex)', () => {
    const text = 'a [[b]] c';
    expect(findPlaceholders(text)).toHaveLength(1);
    expect(findPlaceholders(text)).toHaveLength(1);
  });
});

describe('isEdited', () => {
  it('compares trimmed text, exactly as the server decides provenance', () => {
    expect(isEdited('Hello there', 'Hello there')).toBe(false);
    expect(isEdited('Hello there', '  Hello there\n')).toBe(false);
    expect(isEdited('Hello there', 'Hello there!')).toBe(true);
    expect(isEdited('Hello there', 'hello there')).toBe(true);
    expect(isEdited('', 'anything')).toBe(true);
  });
});

describe('labels', () => {
  it('has a label for every intent the database knows, and a plain-words text for every risk flag the model can raise', () => {
    for (const intent of draftIntent.enumValues) expect(INTENT_LABEL[intent], intent).toBeTruthy();
    for (const flag of RISK_FLAGS) expect(riskFlagLabel(flag)).not.toBe(flag);
    expect(riskFlagLabel('missing_facts_unmarked')).toMatch(/missing/i);
  });

  it('falls back to readable text for a value it has never seen, instead of showing nothing', () => {
    expect(intentLabel('brand_new')).toBe('brand_new');
    expect(riskFlagLabel('some_new_flag')).toBe('some new flag');
    expect(intentTone('brand_new')).toBe('neutral');
  });

  it('marks the intents that need a second read', () => {
    expect(intentTone('complaint')).toBe('danger');
    expect(intentTone('asks_for_human')).toBe('warning');
    expect(intentTone('chit_chat')).toBe('neutral');
  });
});

describe('describeEditRate', () => {
  it('says there is no history when nothing was sent', () => {
    expect(describeEditRate({ sent: 0, edited: 0, medianEditDistance: null }, 'payment')).toMatch(/not sent any/);
  });

  it('refuses to show a percentage from a handful of drafts', () => {
    const text = describeEditRate({ sent: 3, edited: 1, medianEditDistance: 0.1 }, 'question');
    expect(text).toMatch(/too few/);
    expect(text).not.toMatch(/%/);
    expect(describeEditRate({ sent: 1, edited: 0, medianEditDistance: 0 }, 'question')).toMatch(/1 “question” draft in/);
  });

  it('gives the rate and the typical size of an edit once there is enough history', () => {
    expect(describeEditRate({ sent: 20, edited: 5, medianEditDistance: 0.134 }, 'chit_chat')).toBe(
      'In the last 90 days you sent 20 “chit-chat” drafts and edited 5 of them (25%), and a typical edit changes about 13% of the text.',
    );
    expect(describeEditRate({ sent: 10, edited: 0, medianEditDistance: null }, 'order')).toBe('In the last 90 days you sent 10 “order” drafts and edited 0 of them (0%).');
  });
});
