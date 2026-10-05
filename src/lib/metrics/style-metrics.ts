/** Per-sample style measures for the evaluation (spec 9.8), all pure. */

const codePoints = (text: string) => Array.from(text.normalize('NFC').trim()).length;

/** Draft length over the real reply's length (1 = same length; 2 = twice as long). */
export function lengthRatio(draft: string, real: string): number {
  return codePoints(draft) / Math.max(1, codePoints(real));
}

const EMOJI = /\p{Extended_Pictographic}/gu;
export function emojiCount(text: string): number {
  return text.match(EMOJI)?.length ?? 0;
}

/** How many more or fewer emoji the draft has than the real reply (absolute). */
export function emojiDifference(draft: string, real: string): number {
  return Math.abs(emojiCount(draft) - emojiCount(real));
}

/** The forbidden patterns (case-insensitive substrings) that the draft contains. */
export function forbiddenHits(draft: string, patterns: readonly string[]): string[] {
  const text = draft.toLowerCase();
  return patterns.filter((pattern) => pattern.trim() !== '' && text.includes(pattern.trim().toLowerCase()));
}
