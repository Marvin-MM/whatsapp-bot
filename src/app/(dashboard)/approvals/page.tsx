import type { Metadata } from 'next';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Approvals' };

export default async function ApprovalsPage() {
  await requireOwnerPage();
  return (
    <>
      <PageHeader title="Approvals" description="Review, edit and approve drafted replies before they are sent." />
      <EmptyState title="No drafts waiting" description="When a customer writes, a draft in your style appears here for you to approve." />
    </>
  );
}
