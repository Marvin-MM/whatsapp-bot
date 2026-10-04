import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Conversation' };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwnerPage();
  const { id } = await params;
  return (
    <>
      <PageHeader title="Conversation" description={`Thread ${id.slice(0, 8)}`} />
      <EmptyState
        title="Conversation not available yet"
        description="The message thread, summary and tasks for this customer will be shown here."
        action={
          <Link href="/conversations" className="text-sm underline underline-offset-4">
            Back to conversations
          </Link>
        }
      />
    </>
  );
}
