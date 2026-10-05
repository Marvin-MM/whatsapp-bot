'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/settings', label: 'General' },
  { href: '/settings/profile', label: 'Business profile' },
  { href: '/settings/problems', label: 'Problems' },
  { href: '/settings/audit', label: 'Audit log' },
] as const;

/** The Settings sections. One scrollable row on a phone; the current one is marked in words (`aria-current`), not by colour alone. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="mb-6">
      <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
        {TABS.map((tab) => {
          const active = tab.href === '/settings' ? pathname === '/settings' : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn('inline-flex h-9 items-center rounded-full border px-3.5 text-sm', active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted')}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
