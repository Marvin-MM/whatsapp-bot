import type { Metadata } from 'next';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Analytics' };

export default async function AnalyticsPage() {
  await requireOwnerPage();
  return (
    <>
      <PageHeader title="Analytics" description="Volume, response time and how close drafts are to what you actually send." />
      <EmptyState title="Not enough data yet" description="Charts appear after the first conversations and approved drafts." />
    </>
  );
}
