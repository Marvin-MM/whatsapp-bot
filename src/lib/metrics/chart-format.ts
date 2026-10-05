/** Formatting for the charts: pure, so both the server-rendered tables and the client charts say the same thing. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-29` -> `29 Sep`. */
export function shortDay(day: string): string {
  const [, month, date] = day.split('-').map(Number);
  return `${date ?? '?'} ${MONTHS[(month ?? 1) - 1] ?? '?'}`;
}

/** `1_234_567` -> `1.2M`, `12_500` -> `12.5k`, `950` -> `950`. */
export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/** A normalised edit distance as the owner reads it: `0.12` (0 = sent exactly as drafted, 1 = nothing in common). */
export const distance = (value: number | null): string => (value === null ? '–' : value.toFixed(2));

/** A share as a whole percent. */
export const percent = (value: number | null): string => (value === null ? '–' : `${Math.round(value * 100)}%`);

/** Money in the owner's currency with enough digits to be useful at fractions of a cent. */
export function money(value: number, currency: string): string {
  const digits = value >= 1 ? 2 : value >= 0.01 ? 3 : 5;
  return `${currency} ${value.toFixed(digits)}`;
}
