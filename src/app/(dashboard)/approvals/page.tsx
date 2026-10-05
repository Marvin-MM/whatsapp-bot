import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Flash } from '@/components/approvals/flash';
import { DraftCard } from '@/components/approvals/draft-card';
import { QueueList } from '@/components/approvals/queue-list';
import { ThreadPanel } from '@/components/approvals/thread-panel';
import { Avatar } from '@/components/conversations/avatar';
import { MessageBubble } from '@/components/conversations/message-bubble';
import { WindowBadge } from '@/components/conversations/window-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { groupByDay } from '@/lib/conversations/group';
import { isUuid } from '@/lib/conversations/params';
import { getThread, oneLine } from '@/lib/conversations/queries';
import { getShellState } from '@/lib/dashboard/shell-state';
import { getDb } from '@/lib/db';
import { getDraftDetail, getOpenDraftId, listApprovalQueue } from '@/lib/drafts/queries';
import { getEnv } from '@/lib/env';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Approvals' };

const RECENT_MESSAGES = 20;

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwnerPage();
  const raw = (await searchParams).d;
  const requested = typeof raw === 'string' && isUuid(raw) ? raw : null;

  const db = getDb();
  const now = new Date();
  const timeZone = getEnv().OWNER_TIMEZONE;
  const queue = await listApprovalQueue(db);

  // `?d=` picks a draft; without it (or with one that does not exist) the oldest waiting draft is shown.
  const detail = (requested ? await getDraftDetail(db, requested, now) : null) ?? (queue[0] ? await getDraftDetail(db, queue[0].id, now) : null);

  // A draft that is no longer open (replaced, regenerated, retried after a failure) hands over to the conversation's open draft, if there is one.
  if (detail && detail.status !== 'pending' && detail.status !== 'scheduled') {
    const replacement = await getOpenDraftId(db, detail.conversationId);
    if (replacement) redirect(`/approvals?d=${replacement}`);
  }

  if (!detail && queue.length === 0) {
    return (
      <>
        <PageHeader title="Approvals" description="Review, edit and approve drafted replies before they are sent." />
        <Flash />
        <EmptyState
          title="No drafts waiting"
          description="When a customer writes, a draft in your style appears here for you to approve. Nothing is ever sent without your approval."
          action={
            <Link href="/conversations?filter=needs_reply" className="text-sm underline underline-offset-4">
              See customers waiting for a reply
            </Link>
          }
        />
      </>
    );
  }

  const index = detail ? queue.findIndex((item) => item.id === detail?.id) : -1;
  const prevId = index > 0 ? (queue[index - 1]?.id ?? null) : null;
  // A draft that has left the queue (just approved, or replaced): "next" is the front of the queue.
  const nextId = index >= 0 ? (queue[index + 1]?.id ?? null) : (queue.find((item) => item.id !== detail?.id)?.id ?? null);

  const thread = detail ? await getThread(db, detail.conversationId, { limit: RECENT_MESSAGES }) : null;
  const shell = await getShellState();
  const triggers = new Set(detail?.triggerMessageIds ?? []);
  const rows = thread ? groupByDay(thread.messages, now, timeZone) : [];
  // What the customer is waiting for, for the collapsed thread on a phone.
  const unanswered = thread ? oneLine(thread.messages.filter((message) => triggers.has(message.id) && message.content).map((message) => message.content).join(' · '), 280) : '';

  return (
    <>
      <PageHeader title="Approvals" description="Review, edit and approve drafted replies before they are sent. Nothing is sent without your approval." hideDescriptionOnPhone />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)] lg:items-start">
        {queue.length > 0 ? (
          <div className="min-w-0 lg:sticky lg:top-[calc(var(--shell-header-h,3.5rem)+1rem)]">
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">
              {queue.length} waiting{queue.length === 200 ? ' (showing the oldest 200)' : ''}
            </h2>
            <QueueList items={queue} selectedId={detail?.id ?? null} now={now} timeZone={timeZone} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No other drafts are waiting.</p>
        )}

        <div className="min-w-0 space-y-4">
          <Flash />
          {detail && thread ? (
            <>
              <header className="flex items-center gap-3">
                <Avatar name={detail.name} className="h-10 w-10" />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-base font-semibold">{detail.name}</h2>
                  {detail.secondary ? <p className="truncate text-sm text-muted-foreground">{detail.secondary}</p> : null}
                </div>
                <WindowBadge expiresAt={detail.windowExpiresAt} serverNow={now} />
                <Link href={`/conversations/${detail.conversationId}`} aria-label="Open the whole conversation" className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
                  <ExternalLink aria-hidden="true" className="h-4 w-4" />
                </Link>
              </header>

              <ThreadPanel messageCount={thread.messages.length} unanswered={unanswered}>
                <ol aria-label="Recent messages" className="space-y-3">
                  {rows.map((row) =>
                    row.kind === 'day' ? (
                      <li key={row.key} className="flex justify-center pt-1">
                        <span className="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground">{row.label}</span>
                      </li>
                    ) : (
                      <MessageBubble key={row.key} message={row.message} timeZone={timeZone} highlight={triggers.has(row.message.id)} />
                    ),
                  )}
                </ol>
              </ThreadPanel>

              <DraftCard
                key={detail.id}
                draft={detail}
                serverNow={now}
                sendingPaused={shell.sendingPaused}
                aiPaused={shell.aiPaused}
                canReceive={thread.conversation.canReceive}
                prevId={prevId}
                nextId={nextId}
              />
              <p className="hidden text-xs text-muted-foreground lg:block">
                Keyboard: <kbd className="rounded border border-border px-1">a</kbd> approve · <kbd className="rounded border border-border px-1">e</kbd> edit ·{' '}
                <kbd className="rounded border border-border px-1">r</kbd> reject · <kbd className="rounded border border-border px-1">g</kbd> regenerate ·{' '}
                <kbd className="rounded border border-border px-1">j</kbd>/<kbd className="rounded border border-border px-1">k</kbd> next / previous
              </p>
            </>
          ) : (
            <EmptyState title="That draft is no longer here" description="Pick one from the list." />
          )}
        </div>
      </div>
    </>
  );
}
