'use client';

import { Ellipsis } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NavIconView } from './nav-icon';
import { NAV_ITEMS, isActivePath } from './nav-items';

const PRIMARY = NAV_ITEMS.filter((item) => item.primary);
const SECONDARY = NAV_ITEMS.filter((item) => !item.primary);

/** Mobile tab bar: the four daily destinations plus a "More" menu. Hidden on md+ screens. */
export function BottomNav() {
  const pathname = usePathname();
  const secondaryActive = SECONDARY.some((item) => isActivePath(pathname, item.href));

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5">
        {PRIMARY.map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <NavIconView name={item.icon} />
                {item.label}
              </Link>
            </li>
          );
        })}
        <li className="relative">
          {/* <details> gives an accessible disclosure menu without client state. */}
          <details className="group">
            <summary
              className={cn(
                'flex min-h-14 cursor-pointer list-none flex-col items-center justify-center gap-0.5 text-xs font-medium [&::-webkit-details-marker]:hidden',
                secondaryActive ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <Ellipsis aria-hidden="true" className="h-5 w-5" />
              More
            </summary>
            <ul className="absolute bottom-full right-2 mb-2 w-44 rounded-lg border border-border bg-card p-1 shadow-lg">
              {SECONDARY.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isActivePath(pathname, item.href) ? 'page' : undefined}
                    className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-muted"
                  >
                    <NavIconView name={item.icon} />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </li>
      </ul>
    </nav>
  );
}
