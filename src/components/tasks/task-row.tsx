'use client';

import { Check, ExternalLink, Pencil, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setTaskStatus, updateTask } from '@/actions/tasks';
import { useNow } from '@/components/conversations/use-now';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { TaskItem } from '@/lib/tasks/queries';
import { TASK_TYPE_LABEL, describeDue, dueState, toLocalInput } from '@/lib/tasks/present';
import { cn } from '@/lib/utils';

interface TaskRowProps {
  task: TaskItem;
  serverNow: Date;
  timeZone: string;
  /** Inside a conversation the customer is already known: leave their name out. */
  showCustomer?: boolean;
}

/**
 * One task with its actions: done, cancel, edit, reopen. The server decides (a task that already changed refuses with a reason); the row
 * only reports what happened. Late tasks are red AND say "Overdue by ..." in words, so colour is never the only signal.
 */
export function TaskRow({ task, serverNow, timeZone, showCustomer = true }: TaskRowProps) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(task.description);
  const [due, setDue] = useState(task.dueAt ? toLocalInput(task.dueAt, timeZone) : '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const open = task.status === 'open';
  const state = open ? dueState(task.dueAt, now, timeZone) : 'none';

  const change = (status: 'open' | 'done' | 'cancelled') => {
    setError(null);
    startTransition(async () => {
      const result = await setTaskStatus({ taskId: task.id, status });
      if (result.ok) router.refresh();
      else {
        setError(result.error.message);
        // Someone else (another tab, the assistant) already changed it: show the truth instead of a stale row.
        if (result.error.code === 'refused') router.refresh();
      }
    });
  };

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await updateTask({ taskId: task.id, description, due: due === '' ? null : due });
      if (result.ok) {
        setEditing(false);
        router.refresh();
      } else if (result.error.code === 'refused' && result.error.reason === 'no_change') {
        setEditing(false);
      } else {
        setError(result.error.fieldErrors ? Object.values(result.error.fieldErrors).flat().join(' ') : result.error.message);
      }
    });
  };

  return (
    <li id={`task-${task.id}`} className={cn('rounded-lg border bg-card p-3', state === 'overdue' ? 'border-destructive/50' : 'border-border')}>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          className="space-y-2"
        >
          <label className="block text-sm font-medium" htmlFor={`desc-${task.id}`}>
            What needs doing
            <input
              id={`desc-${task.id}`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={200}
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm"
            />
          </label>
          <label className="block text-sm font-medium" htmlFor={`due-${task.id}`}>
            When (your time)
            <div className="mt-1 flex gap-2">
              <input
                id={`due-${task.id}`}
                type="datetime-local"
                value={due}
                onChange={(event) => setDue(event.target.value)}
                className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base md:text-sm"
              />
              <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => setDue('')} disabled={due === ''}>
                No time
              </Button>
            </div>
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending || description.trim() === ''}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setError(null);
                setDescription(task.description);
                setDue(task.dueAt ? toLocalInput(task.dueAt, timeZone) : '');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className={cn('text-sm font-medium', !open && 'text-muted-foreground line-through')}>{task.description}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <Badge variant="neutral">{TASK_TYPE_LABEL[task.type]}</Badge>
              {open ? (
                <span className={cn(state === 'overdue' ? 'font-semibold text-destructive' : state === 'today' ? 'font-medium text-warning' : 'text-muted-foreground')}>
                  {describeDue(task.dueAt, now, timeZone)}
                </span>
              ) : (
                <span className="text-muted-foreground">{task.status === 'done' ? 'Done' : 'Cancelled'}</span>
              )}
              {task.createdBy === 'ai' ? <span className="text-muted-foreground">noted by the assistant</span> : null}
              {showCustomer ? (
                <Link href={`/conversations/${task.conversationId}`} className="text-muted-foreground underline underline-offset-4">
                  {task.contactName}
                </Link>
              ) : null}
            </div>
            {task.sourceMessageId ? (
              <Link
                href={`/conversations/${task.conversationId}#m-${task.sourceMessageId}`}
                className="inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground underline underline-offset-4"
              >
                <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />
                <span className="truncate">{task.sourcePreview ? `From: “${task.sourcePreview}”` : 'Go to the message'}</span>
              </Link>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {open ? (
              <>
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => change('done')} disabled={pending} aria-label={`Mark done: ${task.description}`} title="Done">
                  <Check aria-hidden="true" className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setEditing(true)} disabled={pending} aria-label={`Edit: ${task.description}`} title="Edit">
                  <Pencil aria-hidden="true" className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => change('cancelled')} disabled={pending} aria-label={`Cancel: ${task.description}`} title="Cancel the task">
                  <X aria-hidden="true" className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => change('open')} disabled={pending} aria-label={`Reopen: ${task.description}`}>
                <RotateCcw aria-hidden="true" className="h-4 w-4" />
                <span className="sr-only sm:not-sr-only">Reopen</span>
              </Button>
            )}
          </div>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}
