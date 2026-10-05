import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shared/page-header';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" description="Switches and connections, your business profile, what has gone wrong, and the audit log." hideDescriptionOnPhone />
      <SettingsNav />
      {children}
    </>
  );
}
