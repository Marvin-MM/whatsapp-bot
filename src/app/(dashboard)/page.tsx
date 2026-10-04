import type { Metadata } from 'next';
import Link from 'next/link';
import { ConversationRow } from '@/components/conversations/conversation-row';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listConversations } from '@/lib/conversations/queries';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage() {
  await requireOwnerPage();
  const { items } = await listConversations(getDb(), { filter: 'needs_reply', limit: 5 });
  const now = new Date();
  const timeZone = getEnv().OWNER_TIMEZONE;

  return (
    <>
      <PageHeader title="Overview" description="What needs your attention right now." />
      {items.length === 0 ? (
        <EmptyState title="Nothing needs attention" description="Customers waiting for a reply, pending approvals, expiring windows and failed messages will show up here." />
      ) : (
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
