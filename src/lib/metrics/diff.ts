/** Small diffs for the style page, written here instead of installed (CLAUDE.md rule 2). Texts are short; the O(n*m) table is fine. */

export type DiffPart = { type: 'same' | 'add' | 'del'; text: string };

const MAX_TOKENS = 1500;

/** Word-level diff of two texts (whitespace kept with its word), via the longest common subsequence. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.match(/\S+\s*/g) ?? [];
  const b = after.match(/\S+\s*/g) ?? [];
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return before === after ? [{ type: 'same', text: before }] : [{ type: 'del', text: before }, { type: 'add', text: after }];
  }
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = table[i];
      const below = table[i + 1];
      if (!row || !below) continue;
      row[j] = a[i]?.trim() === b[j]?.trim() ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const parts: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string) => {
    const last = parts.at(-1);
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]?.trim() === b[j]?.trim()) {
      push('same', b[j] ?? '');
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      push('del', a[i] ?? '');
      i += 1;
    } else {
      push('add', b[j] ?? '');
      j += 1;
    }
  }
  while (i < a.length) push('del', a[i++] ?? '');
  while (j < b.length) push('add', b[j++] ?? '');
  return parts;
}

export interface ListDiff {
  kept: string[];
  added: string[];
  removed: string[];
}

/** Items present in both lists, only in `after`, only in `before` (exact match, original order). */
export function diffLists(before: readonly string[], after: readonly string[]): ListDiff {
  const had = new Set(before);
  const has = new Set(after);
  return { kept: after.filter((item) => had.has(item)), added: after.filter((item) => !had.has(item)), removed: before.filter((item) => !has.has(item)) };
}
