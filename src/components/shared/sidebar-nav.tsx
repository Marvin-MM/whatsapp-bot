'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NavIconView } from './nav-icon';
import { NAV_ITEMS, type NavBadges, badgeFor, formatBadge, isActivePath } from './nav-items';

/** Desktop navigation: every destination, always visible. */
export function SidebarNav({ badges }: { badges?: NavBadges }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map((item) => {
        const active = isActivePath(pathname, item.href);
        const badge = badgeFor(badges, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <NavIconView name={item.icon} />
            {item.label}
            {badge > 0 ? (
              <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                {formatBadge(badge)}
                <span className="sr-only"> waiting</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
