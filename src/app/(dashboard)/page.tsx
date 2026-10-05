import type { Metadata } from 'next';
import Link from 'next/link';
import { ConversationRow } from '@/components/conversations/conversation-row';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listConversations } from '@/lib/conversations/queries';
import { getDb } from '@/lib/db';
import { countOpenDrafts } from '@/lib/drafts/queries';
import { getEnv } from '@/lib/env';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage() {
  await requireOwnerPage();
  const { items } = await listConversations(getDb(), { filter: 'needs_reply', limit: 5 });
  const pendingDrafts = await countOpenDrafts(getDb());
  const now = new Date();
  const timeZone = getEnv().OWNER_TIMEZONE;

  return (
    <>
      <PageHeader title="Overview" description="What needs your attention right now." />
      {pendingDrafts > 0 ? (
        <Card className="mb-4">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>
                {pendingDrafts} draft{pendingDrafts === 1 ? '' : 's'} waiting for your approval
              </CardTitle>
              <p className="mt-1.5 text-sm text-muted-foreground">Nothing is sent until you approve it.</p>
            </div>
            <Link href="/approvals" className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">
              Review
            </Link>
          </CardHeader>
        </Card>
      ) : null}
      {items.length === 0 && pendingDrafts === 0 ? (
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
