import Link from 'next/link';
import { Avatar } from '@/components/conversations/avatar';
import { Badge } from '@/components/ui/badge';
import { formatListTime } from '@/lib/conversations/format';
import type { QueueItem } from '@/lib/drafts/queries';
import { intentLabel, intentTone } from '@/lib/drafts/present';
import { cn } from '@/lib/utils';

/**
 * Who is waiting, oldest first. A horizontal strip on a phone (the draft must stay on screen), a vertical list from `lg` up.
 * Each entry is a plain link to `/approvals?d=<id>`: selecting a draft is a navigation, so the back button and a reload both work.
 */
export function QueueList({ items, selectedId, now, timeZone }: { items: QueueItem[]; selectedId: string | null; now: Date; timeZone: string }) {
  return (
    <nav aria-label="Drafts waiting for you">
      <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <li key={item.id} className="w-52 shrink-0 lg:w-auto">
              <Link
                href={`/approvals?d=${item.id}`}
                aria-current={selected ? 'true' : undefined}
                className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2', selected ? 'border-primary bg-card shadow-sm' : 'border-border bg-card hover:bg-muted/60')}
              >
                <Avatar name={item.name} className="h-8 w-8" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{item.name}</span>
                    <time dateTime={item.createdAt.toISOString()} className="shrink-0 text-xs text-muted-foreground">
                      {formatListTime(item.createdAt, now, timeZone)}
                    </time>
                  </span>
                  {/* The strip on a phone is for switching, not reading: the message itself is in the panel below. */}
                  <span className="hidden truncate text-sm text-muted-foreground lg:block">{item.preview || 'No text'}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {item.status === 'failed' ? (
                      <Badge variant="danger">Draft failed</Badge>
                    ) : item.noReplyNeeded ? (
                      <Badge variant="neutral">No reply needed?</Badge>
                    ) : (
                      <Badge variant={intentTone(item.intent) === 'neutral' ? 'neutral' : intentTone(item.intent)}>{intentLabel(item.intent)}</Badge>
                    )}
                    {item.status === 'scheduled' ? <Badge variant="info">Scheduled</Badge> : null}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
