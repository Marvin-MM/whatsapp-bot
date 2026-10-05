/**
 * How different two texts are, as a number from 0 (identical) to 1 (nothing in common): Levenshtein distance over Unicode code points
 * (an emoji is ONE edit, not two), divided by the length of the longer text. Both texts are NFC-normalised and trimmed first, so an
 * accent written two ways or a trailing space is not an "edit". This is the single definition used for draft provenance, the
 * evaluation, the analytics chart and the autopilot gate.
 */

export function levenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

const prepare = (text: string): string[] => Array.from(text.normalize('NFC').trim());

export function editDistance(original: string, final: string): number {
  const a = prepare(original);
  const b = prepare(final);
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : levenshtein(a, b) / longest;
}
