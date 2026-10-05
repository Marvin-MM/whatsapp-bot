'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createTask } from '@/actions/tasks';
import { Button } from '@/components/ui/button';
import type { ConversationChoice } from '@/lib/tasks/queries';
import { TASK_TYPE_LABEL, type TaskType } from '@/lib/tasks/present';

interface AddTaskFormProps {
  /** A fixed conversation (inside a thread), or a list to choose from (the Tasks page). */
  conversationId?: string;
  conversations?: readonly ConversationChoice[];
  defaultType?: TaskType;
}

/** Add a task by hand. The time is the owner's own wall clock (the server reads it in their time zone). */
export function AddTaskForm({ conversationId, conversations = [], defaultType = 'followup' }: AddTaskFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(conversationId ?? conversations[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TaskType>(defaultType);
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={conversationId === undefined && conversations.length === 0}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Add a task
      </Button>
    );
  }

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createTask({ conversationId: choice, description, type, due: due === '' ? null : due });
      if (result.ok) {
        setDescription('');
        setDue('');
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error.fieldErrors ? Object.values(result.error.fieldErrors).flat().join(' ') : result.error.message);
      }
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="space-y-3 rounded-lg border border-border bg-card p-3"
      aria-label="Add a task"
    >
      {conversationId === undefined ? (
        <label className="block text-sm font-medium" htmlFor="new-task-conversation">
          Customer
          <select id="new-task-conversation" value={choice} onChange={(event) => setChoice(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm">
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="block text-sm font-medium" htmlFor="new-task-description">
        What needs doing
        <input
          id="new-task-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={200}
          placeholder="Call back about delivery"
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium" htmlFor="new-task-type">
          Kind
          <select id="new-task-type" value={type} onChange={(event) => setType(event.target.value as TaskType)} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm">
            {(Object.keys(TASK_TYPE_LABEL) as TaskType[]).map((key) => (
              <option key={key} value={key}>
                {TASK_TYPE_LABEL[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium" htmlFor="new-task-due">
          When (your time, optional)
          <input id="new-task-due" type="datetime-local" value={due} onChange={(event) => setDue(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm" />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending || description.trim() === '' || choice === ''}>
          {pending ? 'Adding…' : 'Add task'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
