import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * DECISIONS.md is the record of where this repo deliberately differs from the spec. Earlier edits once left four copies of the Phase 0 and 1 sections
 * in it (905 lines for 91 decisions) and nothing noticed, because nothing read it. These tests read it.
 */
const text = readFileSync(new URL('../../DECISIONS.md', import.meta.url), 'utf8');
const ids = [...text.matchAll(/^\*\*D-(\d{3}) /gm)].map((match) => Number(match[1]));
const headings = [...text.matchAll(/^## .+$/gm)].map((match) => match[0]);

describe('DECISIONS.md', () => {
  it('records every decision exactly once', () => {
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(repeated).toEqual([]);
  });

  it('numbers its decisions without gaps, starting at D-001', () => {
    const sorted = [...ids].sort((a, b) => a - b);
    expect(sorted[0]).toBe(1);
    expect(sorted).toEqual(sorted.map((_, index) => index + 1));
  });

  it('lists the decisions in order (a later phase never sits above an earlier one)', () => {
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('has each phase heading once, and only one title', () => {
    expect(new Set(headings).size).toBe(headings.length);
    expect(text.match(/^# DECISIONS$/gm)).toHaveLength(1);
  });
});
