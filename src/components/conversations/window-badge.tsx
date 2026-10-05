'use client';

import { Badge } from '@/components/ui/badge';
import { describeWindow, windowState } from '@/lib/conversations/window';
import { useNow } from './use-now';

const VARIANT = { success: 'success', warning: 'warning', danger: 'danger', neutral: 'neutral' } as const;

/**
 * The 24h window in one badge, ticking: a thread left open must not keep promising "23h left" for hours, because the composer
 * beside it enforces the same window. The title carries the full explanation of what can be sent.
 */
export function WindowBadge({ expiresAt, serverNow, className }: { expiresAt: Date | null; serverNow: Date; className?: string }) {
  const now = useNow(serverNow);
  const description = describeWindow(windowState(expiresAt, now));
  return (
    <Badge variant={VARIANT[description.tone]} title={description.detail} className={className}>
      {description.label}
    </Badge>
  );
}

/** The plain-words explanation under the header, from the same ticking clock. */
export function WindowDetail({ expiresAt, serverNow, className }: { expiresAt: Date | null; serverNow: Date; className?: string }) {
  const now = useNow(serverNow);
  return <p className={className}>{describeWindow(windowState(expiresAt, now)).detail}</p>;
}
