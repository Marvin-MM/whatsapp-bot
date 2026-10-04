import Link from 'next/link';
import { formatListTime } from '@/lib/conversations/format';
import type { ConversationListItem } from '@/lib/conversations/queries';
import { windowState } from '@/lib/conversations/window';
import { Badge } from '@/components/ui/badge';
import { Avatar } from './avatar';
import { DeliveryStatus } from './delivery-status';
import { ConversationStatusBadge } from './status-badge';

/**
 * One row of the conversation list. The whole row is the link (a large touch target); the status and window are text badges,
 * so nothing relies on colour alone.
 */
export function ConversationRow({ item, now, timeZone }: { item: ConversationListItem; now: Date; timeZone: string }) {
  const window = windowState(item.windowExpiresAt, now);
  const needsReply = item.status === 'open' || item.status === 'waiting_on_me';
  const time = formatListTime(item.lastMessageAt, now, timeZone);

  return (
    <li>
      <Link
        href={`/conversations/${item.id}`}
        className="flex items-start gap-3 rounded-lg border border-transparent px-3 py-3 hover:border-border hover:bg-muted/60"
      >
        <Avatar name={item.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-sm ${needsReply ? 'font-semibold' : 'font-medium'}`}>{item.name}</span>
            <time dateTime={item.lastMessageAt.toISOString()} className="shrink-0 text-xs text-muted-foreground">
              {time}
            </time>
          </div>
          <p className="flex items-center gap-1 truncate text-sm text-muted-foreground">
            {item.preview ? (
              <>
                {item.preview.direction === 'outbound' ? (
                  <>
                    <DeliveryStatus status={item.preview.status} />
                    <span className="shrink-0">You:</span>
                  </>
                ) : null}
                <span className="truncate">{item.preview.text}</span>
              </>
            ) : (
              'No messages yet'
            )}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <ConversationStatusBadge status={item.status} />
            {item.pendingDrafts > 0 ? <Badge variant="warning">{item.pendingDrafts} draft{item.pendingDrafts === 1 ? '' : 's'} to review</Badge> : null}
            {window.kind === 'expiring' ? <Badge variant="warning">Window closing soon</Badge> : null}
            {window.kind === 'closed' && needsReply ? <Badge variant="danger">Window closed</Badge> : null}
          </div>
        </div>
      </Link>
    </li>
  );
}
