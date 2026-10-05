/**
 * A deliberately tiny markdown reader for the business-profile preview. It produces DATA (blocks and inlines), never HTML: the page turns
 * that into React elements, so nothing the owner (or anything pasted into the box) types can become markup, a script or a live link.
 *
 * Supported: `#`..`###` headings, `-` / `*` bullets, `1.` numbered items, `---` rules, paragraphs (a line break stays a line break),
 * `**bold**`, `*italic*` / `_italic_`, `` `code` ``. Everything else, including `[links](https://...)`, `<tags>` and images, is shown as the
 * plain text it is.
 */

export type Inline = { type: 'text'; text: string } | { type: 'bold'; text: string } | { type: 'italic'; text: string } | { type: 'code'; text: string };

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: 'ul'; items: Inline[][] }
  | { type: 'ol'; items: Inline[][] }
  | { type: 'p'; lines: Inline[][] }
  | { type: 'hr' };

// Underscore emphasis needs word boundaries, so `snake_case_word` and `blue_dress_m` stay as written.
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*|(?<![A-Za-z0-9_])_[^_\s][^_\n]*_(?![A-Za-z0-9_]))/g;

export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) parts.push({ type: 'text', text: text.slice(last, start) });
    if (token.startsWith('**')) parts.push({ type: 'bold', text: token.slice(2, -2) });
    else if (token.startsWith('`')) parts.push({ type: 'code', text: token.slice(1, -1) });
    else parts.push({ type: 'italic', text: token.slice(1, -1) });
    last = start + token.length;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push({ type: 'p', lines: paragraph.map(parseInline) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: list.type, items: list.items.map(parseInline) });
    list = null;
  };

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'hr' });
    } else if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: heading[1]?.length === 1 ? 1 : heading[1]?.length === 2 ? 2 : 3, inlines: parseInline(heading[2] ?? '') });
    } else if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      list ??= { type, items: [] };
      list.items.push((bullet ?? numbered)?.[1] ?? '');
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
