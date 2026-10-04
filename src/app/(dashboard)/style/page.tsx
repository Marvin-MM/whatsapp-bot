import type { Metadata } from 'next';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Style' };

export default async function StylePage() {
  await requireOwnerPage();
  return (
    <>
      <PageHeader title="Style" description="How the assistant writes like you." />
      <EmptyState
        title="No style guide yet"
        description="Import your past chats and extract a style guide; drafts are generic until one is active."
      />
    </>
  );
}
