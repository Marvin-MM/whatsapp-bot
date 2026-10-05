import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from '@/components/settings/markdown-preview';
import { parseInline, parseMarkdown } from '@/lib/markdown';

describe('parseMarkdown', () => {
  it('reads headings, bullets, numbered items, rules and paragraphs', () => {
    const blocks = parseMarkdown('# Shop\n\nWe sell **dresses** and _bags_.\nOpen 9-6.\n\n## Prices\n- Blue dress: `50,000`\n- Red bag: 30,000\n\n1. Pay\n2) Collect\n---\nDone');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'p', 'heading', 'ul', 'ol', 'hr', 'p']);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    expect(blocks[1]).toMatchObject({ type: 'p', lines: [expect.any(Array), [{ type: 'text', text: 'Open 9-6.' }]] });
    expect(blocks[3]).toMatchObject({ type: 'ul', items: [expect.any(Array), expect.any(Array)] });
    expect((blocks[4] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('inline formatting: bold, italic (both marks), code, and plain text around them', () => {
    expect(parseInline('a **b** c *d* e _f_ `g`')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'bold', text: 'b' },
      { type: 'text', text: ' c ' },
      { type: 'italic', text: 'd' },
      { type: 'text', text: ' e ' },
      { type: 'italic', text: 'f' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'g' },
    ]);
    expect(parseInline('snake_case_word and 2 * 3 * 4')).toEqual([{ type: 'text', text: 'snake_case_word and 2 * 3 * 4' }]);
  });

  it('handles empty input, blank lines, CRLF and a list directly after a paragraph', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n   \n')).toEqual([]);
    expect(parseMarkdown('a\r\n- b\r\n- c').map((b) => b.type)).toEqual(['p', 'ul']);
    expect(parseMarkdown('- a\n1. b').map((b) => b.type)).toEqual(['ul', 'ol']);
  });
});

describe('MarkdownPreview never produces markup from the owner’s text', () => {
  const html = renderToStaticMarkup(createElement(MarkdownPreview, { source: '<script>alert(1)</script> [click](javascript:alert(1)) <img src=x onerror=alert(1)>\n\n**<b>bold</b>**\n\n![x](http://evil/x.png)' }));

  it('escapes tags and renders links and images as the plain text they are', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<a[ >]/i);
    expect(html).not.toMatch(/href=/i);
    expect(html).not.toMatch(/onerror=(?!.*&gt;)/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('[click](javascript:alert(1))');
  });

  it('says so when there is nothing to show', () => {
    expect(renderToStaticMarkup(createElement(MarkdownPreview, { source: '  ' }))).toContain('Nothing written yet');
  });
});
