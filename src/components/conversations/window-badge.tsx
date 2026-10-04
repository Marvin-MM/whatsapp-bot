import { Badge } from '@/components/ui/badge';
import { describeWindow, windowState } from '@/lib/conversations/window';

const VARIANT = { success: 'success', warning: 'warning', danger: 'danger', neutral: 'neutral' } as const;

/** The 24h window in one badge. The title carries the full explanation of what can be sent. */
export function WindowBadge({ expiresAt, now, className }: { expiresAt: Date | null; now: Date; className?: string }) {
  const description = describeWindow(windowState(expiresAt, now));
  return (
    <Badge variant={VARIANT[description.tone]} title={description.detail} className={className}>
      {description.label}
    </Badge>
  );
}
