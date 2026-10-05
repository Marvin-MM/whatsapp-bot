import { ListChecks } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { TaskItem } from '@/lib/tasks/queries';
import { AddTaskForm } from './add-task-form';
import { TaskRow } from './task-row';

interface ConversationPanelProps {
  conversationId: string;
  summary: string | null;
  open: TaskItem[];
  recentlyClosed: TaskItem[];
  now: Date;
  timeZone: string;
}

/**
 * What the assistant knows about this customer and what the owner still owes them, above the thread. A native `<details>`: closed on
 * every screen so the thread stays the first thing on a phone, with the summary's first line and the number of open (and late) tasks
 * visible on the closed bar.
 */
export function ConversationPanel({ conversationId, summary, open, recentlyClosed, now, timeZone }: ConversationPanelProps) {
  const late = open.filter((task) => task.dueAt !== null && task.dueAt.getTime() < now.getTime()).length;
  return (
    <details className="group mb-4 rounded-lg border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
        <ListChecks aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{summary ? summary : <span className="text-muted-foreground">No summary yet: it is written after you reply.</span>}</span>
        {late > 0 ? <Badge variant="danger">{late} late</Badge> : null}
        <Badge variant={open.length > 0 ? 'warning' : 'neutral'}>
          {open.length} open
          <span className="sr-only"> task{open.length === 1 ? '' : 's'}</span>
        </Badge>
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-3">
        <section aria-label="Summary">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</h2>
          <p className="text-sm">{summary ?? 'Nothing yet. A short summary is written after each reply you send.'}</p>
        </section>
        <section aria-label="Tasks" className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Open tasks</h2>
          {open.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing owed.</p>
          ) : (
            <ul className="space-y-2">
              {open.map((task) => (
                <TaskRow key={task.id} task={task} serverNow={now} timeZone={timeZone} showCustomer={false} />
              ))}
            </ul>
          )}
          <AddTaskForm conversationId={conversationId} />
        </section>
        {recentlyClosed.length > 0 ? (
          <section aria-label="Recently finished" className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recently finished</h2>
            <ul className="space-y-2">
              {recentlyClosed.map((task) => (
                <TaskRow key={task.id} task={task} serverNow={now} timeZone={timeZone} showCustomer={false} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </details>
  );
}
