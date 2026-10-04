import type { Metadata } from 'next';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { ConversationRow } from '@/components/conversations/conversation-row';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { listHref, parseListParams } from '@/lib/conversations/params';
import { LIST_FILTERS, type ListFilter, listConversations } from '@/lib/conversations/queries';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Conversations' };

const FILTER_LABEL: Record<ListFilter, string> = { all: 'All', needs_reply: 'Needs reply', waiting: 'Waiting on customer', resolved: 'Resolved' };

export default async function ConversationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwnerPage();
  const { filter, q, cursor } = parseListParams(await searchParams);
  const page = await listConversations(getDb(), { filter, q, cursor });
  const now = new Date();
  const timeZone = getEnv().OWNER_TIMEZONE;
  const searching = q !== '' || filter !== 'all';

  return (
    <>
      <PageHeader title="Conversations" description="Every customer thread, newest first." />

      <div className="mb-4 space-y-3">
        <form method="get" role="search" action="/conversations" className="flex gap-2">
          <label htmlFor="q" className="sr-only">
            Search conversations
          </label>
          <Input id="q" name="q" type="search" defaultValue={q} placeholder="Search names, numbers and messages" maxLength={100} autoComplete="off" />
          {filter !== 'all' ? <input type="hidden" name="filter" value={filter} /> : null}
          <Button type="submit" variant="outline" size="icon" aria-label="Search">
            <Search aria-hidden="true" className="h-4 w-4" />
          </Button>
        </form>

        <nav aria-label="Filter conversations">
          <ul className="flex flex-wrap gap-1.5">
            {LIST_FILTERS.map((option) => (
              <li key={option}>
                <Link
                  href={listHref({ filter: option, q })}
                  aria-current={option === filter ? 'page' : undefined}
                  className={`inline-flex h-9 items-center rounded-full border px-3 text-sm ${
                    option === filter ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted'
                  }`}
                >
                  {FILTER_LABEL[option]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {page.items.length === 0 ? (
        searching ? (
          <EmptyState
            title="No conversations match"
            description="Try different words, a part of a phone number, or clear the filter."
            action={
              <Link href="/conversations" className="text-sm underline underline-offset-4">
                Clear search and filter
              </Link>
            }
          />
        ) : (
          <EmptyState title="No conversations yet" description="Conversations appear as soon as a customer messages your WhatsApp number." />
        )
      ) : (
        <>
          <ul aria-label="Conversations" className="space-y-1">
            {page.items.map((item) => (
              <ConversationRow key={item.id} item={item} now={now} timeZone={timeZone} />
            ))}
          </ul>
          {page.nextCursor ? (
            <div className="mt-4 flex justify-center">
              <Link href={listHref({ filter, q, cursor: page.nextCursor })} className="inline-flex h-10 items-center rounded-md border border-input bg-card px-4 text-sm hover:bg-muted">
                Older conversations
              </Link>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
