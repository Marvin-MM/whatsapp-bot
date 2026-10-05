import { STYLE_FIELDS } from '@/lib/ai/style-fields';
import { diffLists, diffWords } from '@/lib/metrics/diff';
import type { StyleGuideContent } from '@/lib/schemas/style-guide';

/**
 * What changes if `selected` replaces `active`: text fields as a word diff (removed words struck through, added words highlighted),
 * list fields as added / removed items. Colour is never the only signal: removed text is struck through, added text underlined.
 */
export function StyleDiff({ active, selected }: { active: StyleGuideContent; selected: StyleGuideContent }) {
  const changed = STYLE_FIELDS.filter((field) => JSON.stringify(active[field.key]) !== JSON.stringify(selected[field.key]));
  if (changed.length === 0) return <p className="text-sm text-muted-foreground">This version is identical to the active one.</p>;

  return (
    <ul className="space-y-4">
      {changed.map((field) => {
        const before = active[field.key];
        const after = selected[field.key];
        return (
          <li key={field.key}>
            <h4 className="mb-1 text-sm font-semibold">{field.label}</h4>
            {typeof before === 'string' && typeof after === 'string' ? (
              <p className="whitespace-pre-wrap text-sm">
                {diffWords(before, after).map((part, index) =>
                  part.type === 'same' ? (
                    <span key={index}>{part.text}</span>
                  ) : part.type === 'del' ? (
                    <del key={index} className="rounded bg-destructive/10 text-destructive">
                      {part.text}
                    </del>
                  ) : (
                    <ins key={index} className="rounded bg-success/10 text-success underline">
                      {part.text}
                    </ins>
                  ),
                )}
              </p>
            ) : Array.isArray(before) && Array.isArray(after) ? (
              <ListChange before={before} after={after} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function ListChange({ before, after }: { before: readonly string[]; after: readonly string[] }) {
  const { added, removed } = diffLists(before, after);
  return (
    <ul className="flex flex-wrap gap-1.5 text-sm">
      {removed.map((item) => (
        <li key={`d-${item}`} className="rounded-md bg-destructive/10 px-2 py-0.5 text-destructive line-through">
          <span className="sr-only">Removed: </span>
          {item}
        </li>
      ))}
      {added.map((item) => (
        <li key={`a-${item}`} className="rounded-md bg-success/10 px-2 py-0.5 text-success underline">
          <span className="sr-only">Added: </span>
          {item}
        </li>
      ))}
    </ul>
  );
}
