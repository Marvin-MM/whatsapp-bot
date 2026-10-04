import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

/** Every list ends here when there is nothing to show: one line saying why, never a blank page. */
export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center shadow-none">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </Card>
  );
}
