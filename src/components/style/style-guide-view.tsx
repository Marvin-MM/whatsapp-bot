import { STYLE_FIELDS } from '@/lib/ai/style-fields';
import type { StyleGuideContent } from '@/lib/schemas/style-guide';

export function StyleGuideView({ content }: { content: StyleGuideContent }) {
  return (
    <dl className="space-y-4">
      {STYLE_FIELDS.map((field) => {
        const value = content[field.key];
        return (
          <div key={field.key}>
            <dt className="text-sm font-semibold">{field.label}</dt>
            <dd className="mt-1 text-sm text-muted-foreground">
              {Array.isArray(value) ? (
                value.length === 0 ? (
                  <span className="italic">None noted</span>
                ) : (
                  <ul className="flex flex-wrap gap-1.5">
                    {value.map((item) => (
                      <li key={item} className="rounded-md border border-border bg-muted px-2 py-0.5 text-foreground">
                        {item}
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="whitespace-pre-wrap text-foreground">{value}</p>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
