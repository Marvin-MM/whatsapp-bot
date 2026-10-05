/** Dashboard navigation (spec section 12). Pure data, so it can be tested without rendering. */

export type NavIcon = 'overview' | 'approvals' | 'conversations' | 'tasks' | 'style' | 'analytics' | 'settings';

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Shown directly in the mobile bottom bar; the rest live under "More". */
  primary: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Overview', icon: 'overview', primary: true },
  { href: '/approvals', label: 'Approvals', icon: 'approvals', primary: true },
  { href: '/conversations', label: 'Chats', icon: 'conversations', primary: true },
  { href: '/tasks', label: 'Tasks', icon: 'tasks', primary: true },
  { href: '/style', label: 'Style', icon: 'style', primary: false },
  { href: '/analytics', label: 'Analytics', icon: 'analytics', primary: false },
  { href: '/settings', label: 'Settings', icon: 'settings', primary: false },
];

/** `/` only matches exactly; other items also match their sub-routes (e.g. /conversations/123). */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Counts shown next to a destination (href -> number), e.g. drafts waiting on the Approvals tab. Zero shows nothing. */
export type NavBadges = Readonly<Record<string, number>>;

export function badgeFor(badges: NavBadges | undefined, href: string): number {
  const value = badges?.[href] ?? 0;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** "99+" keeps the badge a fixed width however long the queue is. */
export const formatBadge = (count: number): string => (count > 99 ? '99+' : String(count));
