import { AlertCircle, Check, CheckCheck, Clock, HelpCircle } from 'lucide-react';
import type { ThreadMessage } from '@/lib/conversations/queries';
import { cn } from '@/lib/utils';

type Status = ThreadMessage['status'];

const LABEL: Readonly<Record<Status, string>> = {
  received: 'Received',
  queued: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  failed: 'Failed to send',
  unknown: 'Not confirmed',
};

/**
 * The delivery state of a message we sent: ticks as people expect them, but never colour alone: every state also has text
 * (visible for the two that need the owner's attention, screen-reader text for the rest).
 */
export function DeliveryStatus({ status, className }: { status: Status; className?: string }) {
  if (status === 'received') return null;
  const common = cn('inline-flex items-center gap-1', className);
  switch (status) {
    case 'queued':
      return (
        <span className={common}>
          <Clock aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{LABEL.queued}</span>
        </span>
      );
    case 'sent':
      return (
        <span className={common}>
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{LABEL.sent}</span>
        </span>
      );
    case 'delivered':
      return (
        <span className={common}>
          <CheckCheck aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{LABEL.delivered}</span>
        </span>
      );
    case 'read':
      return (
        <span className={cn(common, 'text-info')}>
          <CheckCheck aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{LABEL.read}</span>
        </span>
      );
    case 'failed':
      return (
        <span className={cn(common, 'font-medium text-destructive')}>
          <AlertCircle aria-hidden="true" className="h-3.5 w-3.5" />
          {LABEL.failed}
        </span>
      );
    case 'unknown':
      return (
        <span className={cn(common, 'font-medium text-warning')}>
          <HelpCircle aria-hidden="true" className="h-3.5 w-3.5" />
          {LABEL.unknown}
        </span>
      );
  }
}
