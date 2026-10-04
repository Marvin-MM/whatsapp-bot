import type { Metadata } from 'next';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Tasks' };

export default async function TasksPage() {
  await requireOwnerPage();
  return (
    <>
      <PageHeader title="Tasks" description="Follow-ups and requests you owe customers." />
      <EmptyState title="No open tasks" description="Promises like “I’ll call you tomorrow” are captured here automatically after you reply." />
    </>
  );
}
