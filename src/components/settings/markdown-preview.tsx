import { type Block, type Inline, parseMarkdown } from '@/lib/markdown';

function Inlines({ items }: { items: readonly Inline[] }) {
  return (
    <>
      {items.map((item, index) =>
        item.type === 'bold' ? (
          <strong key={index}>{item.text}</strong>
        ) : item.type === 'italic' ? (
          <em key={index}>{item.text}</em>
        ) : item.type === 'code' ? (
          <code key={index} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">
            {item.text}
          </code>
        ) : (
          <span key={index}>{item.text}</span>
        ),
      )}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': {
      const size = block.level === 1 ? 'text-lg font-semibold' : block.level === 2 ? 'text-base font-semibold' : 'text-sm font-semibold';
      return (
        <p role="heading" aria-level={block.level + 2} className={size}>
          <Inlines items={block.inlines} />
        </p>
      );
    }
    case 'ul':
      return (
        <ul className="list-inside list-disc space-y-0.5">
          {block.items.map((item, index) => (
            <li key={index}>
              <Inlines items={item} />
            </li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol className="list-inside list-decimal space-y-0.5">
          {block.items.map((item, index) => (
            <li key={index}>
              <Inlines items={item} />
            </li>
          ))}
        </ol>
      );
    case 'hr':
      return <hr className="border-border" />;
    case 'p':
      return (
        <p>
          {block.lines.map((line, index) => (
            <span key={index}>
              {index > 0 ? <br /> : null}
              <Inlines items={line} />
            </span>
          ))}
        </p>
      );
  }
}

/** The business profile as it will read, drawn from parsed data: no HTML is ever produced from the owner's text. */
export function MarkdownPreview({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return <p className="text-sm italic text-muted-foreground">Nothing written yet.</p>;
  return (
    <div className="space-y-2 text-sm">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}
