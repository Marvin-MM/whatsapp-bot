import type { StyleGuideContent } from '@/lib/schemas/style-guide';

/** The style guide's fields in display order: one table for the /style page, the diff and the text put in the drafting prompt. */
export const STYLE_FIELDS: ReadonlyArray<{ key: keyof StyleGuideContent; label: string; kind: 'text' | 'list' }> = [
  { key: 'tone', label: 'Tone', kind: 'text' },
  { key: 'sentenceLength', label: 'Sentence length', kind: 'text' },
  { key: 'punctuationAndCase', label: 'Punctuation and capitals', kind: 'text' },
  { key: 'emojiUsage', label: 'Emoji', kind: 'text' },
  { key: 'languageMixing', label: 'Language mixing', kind: 'text' },
  { key: 'greetingsAndSignoffs', label: 'Greetings and sign-offs', kind: 'list' },
  { key: 'vocabulary', label: 'Vocabulary', kind: 'list' },
  { key: 'commonPhrases', label: 'Common phrases', kind: 'list' },
  { key: 'structuralPatterns', label: 'Structure', kind: 'list' },
  { key: 'forbiddenPatterns', label: 'Never says', kind: 'list' },
];

/**
 * The guide as plain text for the drafting prompt. `forbiddenPatterns` is left out on purpose: the prompt has its own
 * `<forbidden_patterns>` section, one pattern per line.
 */
export function renderStyleGuide(content: StyleGuideContent): string {
  return STYLE_FIELDS.filter((field) => field.key !== 'forbiddenPatterns')
    .map((field) => {
      const value = content[field.key];
      if (Array.isArray(value)) return value.length === 0 ? `${field.label}: (none noted)` : `${field.label}: ${value.map((item) => `"${item}"`).join(', ')}`;
      return `${field.label}: ${value}`;
    })
    .join('\n');
}
