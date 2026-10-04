import { ChartColumn, Inbox, LayoutDashboard, ListChecks, MessagesSquare, Palette, Settings } from 'lucide-react';
import type { NavIcon } from './nav-items';

const ICONS = {
  overview: LayoutDashboard,
  approvals: Inbox,
  conversations: MessagesSquare,
  tasks: ListChecks,
  style: Palette,
  analytics: ChartColumn,
  settings: Settings,
} satisfies Record<NavIcon, typeof Settings>;

export function NavIconView({ name, className }: { name: NavIcon; className?: string }) {
  const Icon = ICONS[name];
  return <Icon aria-hidden="true" className={className ?? 'h-5 w-5'} />;
}
