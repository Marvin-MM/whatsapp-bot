import { describe, expect, it } from 'vitest';
import { compactNumber, distance, money, percent, shortDay } from '@/lib/metrics/chart-format';

describe('chart formatting', () => {
  it('shortDay names the day and month', () => {
    expect(shortDay('2026-09-29')).toBe('29 Sep');
    expect(shortDay('2026-01-05')).toBe('5 Jan');
    expect(shortDay('2026-12-31')).toBe('31 Dec');
  });

  it.each([
    [0, '0'],
    [950, '950'],
    [9_999, '9999'],
    [12_500, '12.5k'],
    [123_456, '123k'],
    [1_234_567, '1.2M'],
    [12_345_678, '12M'],
  ])('compactNumber(%d) = %s', (value, expected) => {
    expect(compactNumber(value)).toBe(expected);
  });

  it('shows "no data" as a dash, never as zero', () => {
    expect(distance(null)).toBe('–');
    expect(percent(null)).toBe('–');
    expect(distance(0)).toBe('0.00');
    expect(distance(0.1234)).toBe('0.12');
    expect(percent(0.5)).toBe('50%');
    expect(percent(0.004)).toBe('0%');
  });

  it('money keeps the small amounts visible', () => {
    expect(money(12.3456, 'USD')).toBe('USD 12.35');
    expect(money(0.0543, 'USD')).toBe('USD 0.054');
    expect(money(0.00054, 'UGX')).toBe('UGX 0.00054');
  });
});
