import type { Metadata } from 'next';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  await requireOwnerPage();
  return (
    <>
      <PageHeader title="Settings" description="WhatsApp health, business profile, kill switches and audit log." />
      <EmptyState
        title="Settings are coming online phase by phase"
        description="The kill-switch state is already shown in the header; controls arrive with the send path."
      />
    </>
  );
}
