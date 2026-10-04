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
