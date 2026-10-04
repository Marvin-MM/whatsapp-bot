import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Avatar } from '@/components/conversations/avatar';
import { MessageBubble } from '@/components/conversations/message-bubble';
import { ConversationStatusBadge } from '@/components/conversations/status-badge';
import { ThreadScroller } from '@/components/conversations/thread-scroller';
import { WindowBadge } from '@/components/conversations/window-badge';
import { groupByDay } from '@/lib/conversations/group';
import { isUuid, parseThreadParams } from '@/lib/conversations/params';
import { getThread } from '@/lib/conversations/queries';
import { describeWindow, windowState } from '@/lib/conversations/window';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Conversation' };

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireOwnerPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { before } = parseThreadParams(await searchParams);
  const thread = await getThread(getDb(), id, { before });
  if (!thread) notFound();

  const now = new Date();
  const timeZone = getEnv().OWNER_TIMEZONE;
  const { conversation, messages } = thread;
  const window = describeWindow(windowState(conversation.windowExpiresAt, now));
  const last = messages.at(-1);

  const rows = groupByDay(messages, now, timeZone);

  return (
    <div className="mx-auto max-w-3xl">
      {/* One compact row on a phone (back, avatar, name, window badge): the sticky bar must not eat the screen. The number,
          status and the plain-words explanation appear from `sm` up, where there is room. */}
      <header className="sticky top-[var(--shell-header-h)] z-20 -mx-4 mb-4 border-b border-border bg-background px-4 py-2 md:-mx-8 md:px-8">
        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/conversations"
            aria-label="All conversations"
            className="-ml-1.5 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft aria-hidden="true" className="h-5 w-5" />
          </Link>
          <Avatar name={conversation.name} className="h-9 w-9 sm:h-10 sm:w-10" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold leading-tight sm:text-lg">{conversation.name}</h1>
            {conversation.secondary ? <p className="hidden truncate text-sm text-muted-foreground sm:block">{conversation.secondary}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="hidden sm:inline-flex">
              <ConversationStatusBadge status={conversation.status} />
            </span>
            <WindowBadge expiresAt={conversation.windowExpiresAt} now={now} />
          </div>
        </div>
        <p className="mt-1 hidden text-xs text-muted-foreground sm:block">{window.detail}</p>
      </header>

      {thread.olderCursor ? (
        <div className="mb-4 flex justify-center">
          <Link
            href={`/conversations/${conversation.id}?before=${encodeURIComponent(thread.olderCursor)}`}
            className="inline-flex h-9 items-center rounded-full border border-border bg-card px-4 text-sm hover:bg-muted"
          >
            Load earlier messages
          </Link>
        </div>
      ) : null}

      {before ? (
        <div className="mb-4 flex justify-center">
          <Link href={`/conversations/${conversation.id}`} className="text-sm underline underline-offset-4">
            Back to the latest messages
          </Link>
        </div>
      ) : null}

      <ThreadScroller lastMessageId={before ? null : (last?.id ?? null)}>
        {messages.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No messages in this conversation yet.</p>
        ) : (
          <ol aria-label="Messages" className="space-y-3 pb-6">
            {rows.map((row) =>
              row.kind === 'day' ? (
                <li key={row.key} className="flex justify-center pt-2">
                  <span className="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground">{row.label}</span>
                </li>
              ) : (
                <MessageBubble key={row.key} message={row.message} timeZone={timeZone} />
              ),
            )}
          </ol>
        )}
      </ThreadScroller>
    </div>
  );
}
