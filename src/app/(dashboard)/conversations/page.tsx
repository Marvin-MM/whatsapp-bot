import type { Metadata } from 'next';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Conversations' };

export default async function ConversationsPage() {
  await requireOwnerPage();
  return (
    <>
      <PageHeader title="Conversations" description="Every customer thread, newest first." />
      <EmptyState title="No conversations yet" description="Conversations appear as soon as a customer messages your WhatsApp number." />
    </>
  );
}
