import { Bell } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { RealtimeListener } from '@/components/realtime/realtime-listener';
import { BottomNav } from '@/components/shared/bottom-nav';
import { KillSwitchBadges } from '@/components/shared/kill-switch-badges';
import { ShellHeaderHeight } from '@/components/shared/shell-header-height';
import { SidebarNav } from '@/components/shared/sidebar-nav';
import { Badge } from '@/components/ui/badge';
import { getShellState } from '@/lib/dashboard/shell-state';
import { requireOwnerPage } from '@/server/require-owner';

// Everything behind the login is per-request and per-user; never prerender or cache it.
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  await requireOwnerPage();
  const state = await getShellState();

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[14rem_1fr]">
      <aside className="hidden border-r border-border bg-card md:sticky md:top-0 md:flex md:h-dvh md:flex-col md:self-start">
        <div className="px-6 py-5 text-sm font-semibold tracking-tight">WhatsApp Assistant</div>
        <SidebarNav />
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header id="shell-header" className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border bg-card px-3 py-2 sm:px-4 md:px-8">
          <KillSwitchBadges state={state} />
          <div className="ml-auto flex items-center gap-1">
            <RealtimeListener />
            <Link
              href="/settings"
              aria-label={`${state.problemCount} messages need attention`}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
            >
              <Bell aria-hidden="true" className="h-4 w-4" />
              <Badge variant={state.problemCount > 0 ? 'danger' : 'neutral'}>{state.problemCount}</Badge>
            </Link>
            <SignOutButton />
          </div>
        </header>

        <ShellHeaderHeight targetId="shell-header" />
        <main className="flex-1 px-4 py-6 pb-24 md:px-8 md:pb-10">{children}</main>
      </div>

      <BottomNav />
    </div>
  );
}
