import type { Metadata } from 'next';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Overview' };

export default async function OverviewPage() {
  await requireOwnerPage();
  return (
    <>
      <PageHeader title="Overview" description="What needs your attention right now." />
      <EmptyState
        title="Nothing needs attention"
        description="Pending approvals, expiring windows, overdue tasks and failed messages will show up here once messages start arriving."
      />
    </>
  );
}
