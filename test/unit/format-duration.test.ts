import { describe, expect, it } from 'vitest';
import { formatDuration } from '@/lib/metrics/response-time';

describe('formatDuration', () => {
  it.each([
    [0, '1 s'],
    [45, '45 s'],
    [59.4, '59 s'],
    [60, '1 min'],
    [754, '13 min'],
    [3599, '60 min'],
    [3600, '1 h'],
    [3600 + 20 * 60, '1 h 20 min'],
    [3 * 3600 + 35 * 60 + 40, '3 h 36 min'],
    [3600 * 5 - 20, '5 h'],
    [47 * 3600, '47 h'],
    [48 * 3600, '2 days'],
    [5 * 86400, '5 days'],
  ])('%d seconds -> %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
