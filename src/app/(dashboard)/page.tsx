import { Clock, FileClock, ListChecks, MessageSquareWarning } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ConversationRow } from '@/components/conversations/conversation-row';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listConversations } from '@/lib/conversations/queries';
import { type AttentionKind, countWaitingOnYou, getNeedsAttention } from '@/lib/dashboard/attention';
import { getDb } from '@/lib/db';
import { countOpenDrafts } from '@/lib/drafts/queries';
import { getEnv } from '@/lib/env';
import { formatDuration, medianResponseTime } from '@/lib/metrics/response-time';
import { countTasks } from '@/lib/tasks/queries';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Overview' };

const ATTENTION_ICON: Record<AttentionKind, typeof Clock> = {
  message_problem: MessageSquareWarning,
  task_overdue: ListChecks,
  window_expiring: Clock,
  draft_waiting: FileClock,
};
const ATTENTION_LABEL: Record<AttentionKind, string> = {
  message_problem: 'Message problem',
  task_overdue: 'Overdue task',
  window_expiring: 'Window closing',
  draft_waiting: 'Draft waiting',
};

function Stat({ label, value, hint, href, tone }: { label: string; value: string; hint?: string; href?: string; tone?: 'danger' }) {
  const body = (
    <Card className={`h-full p-4 ${href ? 'hover:bg-muted/50' : ''}`}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight ${tone === 'danger' ? 'text-destructive' : ''}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export default async function OverviewPage() {
  await requireOwnerPage();
  const db = getDb();
  const now = new Date();
  const timeZone = getEnv().OWNER_TIMEZONE;
  const [{ items }, pendingDrafts, waitingOnYou, tasks, response, attention] = await Promise.all([
    listConversations(db, { filter: 'needs_reply', limit: 5 }),
    countOpenDrafts(db),
    countWaitingOnYou(db),
    countTasks(db, now),
    medianResponseTime(db, now, 7),
    getNeedsAttention(db, now),
  ]);

  return (
    <>
      <PageHeader title="Overview" description="What needs your attention right now." hideDescriptionOnPhone />

      <section aria-label="At a glance" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Drafts to approve" value={String(pendingDrafts)} hint={pendingDrafts > 0 ? 'Nothing is sent until you approve it.' : 'All caught up.'} href="/approvals" />
        <Stat label="Waiting for your reply" value={String(waitingOnYou)} href="/conversations?filter=needs_reply" />
        <Stat
          label="Open tasks"
          value={String(tasks.open)}
          hint={tasks.overdue > 0 ? `${tasks.overdue} overdue` : tasks.open > 0 ? 'None overdue.' : undefined}
          tone={tasks.overdue > 0 ? 'danger' : undefined}
          href="/tasks"
        />
        <Stat
          label="Median first reply (7 days)"
          value={response.medianSeconds === null ? '–' : formatDuration(response.medianSeconds)}
          hint={response.samples > 0 ? `over ${response.samples} first message${response.samples === 1 ? '' : 's'}` : 'No replies to measure yet.'}
        />
      </section>

      <section aria-label="Needs attention" className="mb-6">
        <h2 className="mb-2 text-base font-semibold">Needs attention</h2>
        {attention.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">Nothing is slipping: no overdue tasks, closing windows, stuck drafts or failed messages.</p>
        ) : (
          <ul className="space-y-2">
            {attention.map((item) => {
              const Icon = ATTENTION_ICON[item.kind];
              const urgent = item.kind === 'message_problem' || item.kind === 'task_overdue';
              return (
                <li key={item.id}>
                  <Link href={item.href} className={`flex items-start gap-3 rounded-lg border bg-card p-3 hover:bg-muted/50 ${urgent ? 'border-destructive/40' : 'border-border'}`}>
                    <Icon aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${urgent ? 'text-destructive' : 'text-warning'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-semibold">{item.name}</span>
                        <span className="text-xs text-muted-foreground">{ATTENTION_LABEL[item.kind]}</span>
                      </span>
                      <span className="block text-sm text-muted-foreground">{item.detail}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {items.length === 0 && pendingDrafts === 0 && attention.length === 0 ? (
        <EmptyState title="Nothing needs attention" description="Customers waiting for a reply, pending approvals, expiring windows and failed messages will show up here." />
      ) : items.length === 0 ? null : (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Waiting for your reply</CardTitle>
            <Link href="/conversations?filter=needs_reply" className="text-sm underline underline-offset-4">
              See all
            </Link>
          </CardHeader>
          <CardContent>
            <ul aria-label="Conversations waiting for your reply" className="space-y-1">
              {items.map((item) => (
                <ConversationRow key={item.id} item={item} now={now} timeZone={timeZone} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
