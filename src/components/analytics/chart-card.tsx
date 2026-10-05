import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/**
 * A chart with its definition above it and its numbers below it. The definition is the point: "median first reply" and "edit distance" mean
 * exactly one thing each, and a chart that does not say what it measures is decoration. The table is the same data as the picture, for a
 * screen reader and for checking.
 */
export function ChartCard({
  title,
  definition,
  empty,
  children,
  table,
  className,
}: {
  title: string;
  definition: string;
  /** Said instead of the chart when there is nothing to draw. */
  empty?: string | undefined;
  children?: ReactNode;
  table?: { columns: string[]; rows: Array<Array<string | number>> };
  className?: string;
}) {
  return (
    <Card className={`p-4 ${className ?? ''}`}>
      <figure>
        <figcaption className="mb-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{definition}</p>
        </figcaption>
        {empty ? <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">{empty}</p> : children}
      </figure>
      {table && !empty ? (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground underline-offset-4 hover:underline">Show the numbers</summary>
          <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {table.columns.map((column) => (
                    <th key={column} scope="col" className="px-2 py-1.5 font-medium">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={String(row[0])} className="border-t border-border">
                    {row.map((cell, index) => (
                      <td key={`${row[0]}-${table.columns[index]}`} className="px-2 py-1 tabular-nums">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </Card>
  );
}

/** One headline number with what it is. */
export function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tracking-tight">{value}</dd>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
