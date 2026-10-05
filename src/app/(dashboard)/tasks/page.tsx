import type { Metadata } from 'next';
import Link from 'next/link';
import { AddTaskForm } from '@/components/tasks/add-task-form';
import { TaskRow } from '@/components/tasks/task-row';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { DUE_FILTERS, type DueFilter, type TaskItem, TYPE_FILTERS, type TypeFilter, listTasks, recentConversations } from '@/lib/tasks/queries';
import { TASK_TYPE_LABEL } from '@/lib/tasks/present';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Tasks' };

const DUE_LABEL: Record<DueFilter, string> = { all: 'Any time', overdue: 'Overdue', today: 'Today', week: 'This week', none: 'No time set' };
const TYPE_LABEL: Record<TypeFilter, string> = { all: 'All kinds', ...TASK_TYPE_LABEL };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const pick = <T extends string>(allowed: readonly T[], value: string | undefined, fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

function hrefFor(type: TypeFilter, due: DueFilter): string {
  const search = new URLSearchParams();
  if (type !== 'all') search.set('type', type);
  if (due !== 'all') search.set('due', due);
  const query = search.toString();
  return query ? `/tasks?${query}` : '/tasks';
}

function Section({ title, tasks, now, timeZone, emptyText }: { title: string; tasks: TaskItem[]; now: Date; timeZone: string; emptyText: string }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">({tasks.length})</span>
      </h2>
      {tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} serverNow={now} timeZone={timeZone} />
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwnerPage();
  const raw = await searchParams;
  const type = pick(TYPE_FILTERS, first(raw.type), 'all');
  const due = pick(DUE_FILTERS, first(raw.due), 'all');
  const now = new Date();
  const timeZone = getEnv().OWNER_TIMEZONE;
  const db = getDb();
  const [page, choices] = await Promise.all([listTasks(db, { type, due }, now, timeZone), recentConversations(db)]);
  const filtered = type !== 'all' || due !== 'all';
  const nothing = page.open.length + page.done.length + page.cancelled.length === 0;

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Follow-ups and requests you owe customers. The assistant notes new ones after you reply; you can add, edit and finish them here."
        hideDescriptionOnPhone
        actions={<AddTaskForm conversations={choices} />}
      />

      <div className="mb-4 space-y-2">
        {([['Kind', TYPE_FILTERS.map((key) => ({ key, label: TYPE_LABEL[key], href: hrefFor(key, due), active: key === type }))], ['When', DUE_FILTERS.map((key) => ({ key, label: DUE_LABEL[key], href: hrefFor(type, key), active: key === due }))]] as const).map(([group, options]) => (
          <nav key={group} aria-label={`Filter by ${group.toLowerCase()}`}>
            {/* One scrollable row on a phone (two wrapping rows of chips would push the tasks off the first screen). */}
            <ul className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
              <li className="mr-1 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group}</li>
              {options.map((option) => (
                <li key={option.key} className="shrink-0">
                  <Link
                    href={option.href}
                    aria-current={option.active ? 'page' : undefined}
                    className={`inline-flex h-8 items-center rounded-full border px-3 text-sm ${option.active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted'}`}
                  >
                    {option.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      {nothing ? (
        <EmptyState
          title={filtered ? 'No tasks match these filters' : 'No tasks yet'}
          description={filtered ? 'Try another filter.' : 'Promises like “I’ll call you tomorrow” are noted here automatically after you reply, and you can add your own.'}
          action={
            filtered ? (
              <Link href="/tasks" className="text-sm underline underline-offset-4">
                Clear the filters
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-6">
          <Section title="Open" tasks={page.open} now={now} timeZone={timeZone} emptyText="Nothing open. Late ones appear first, in red." />
          <Section title="Done" tasks={page.done} now={now} timeZone={timeZone} emptyText="Nothing finished yet." />
          <Section title="Cancelled" tasks={page.cancelled} now={now} timeZone={timeZone} emptyText="Nothing cancelled." />
        </div>
      )}
    </>
  );
}
