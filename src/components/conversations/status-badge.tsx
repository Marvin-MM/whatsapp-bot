import { Badge } from '@/components/ui/badge';
import type { ConversationListItem } from '@/lib/conversations/queries';

const LABEL = { open: 'Needs reply', waiting_on_me: 'Needs reply', waiting_on_customer: 'Waiting on customer', resolved: 'Resolved' } as const;
const VARIANT = { open: 'info', waiting_on_me: 'info', waiting_on_customer: 'neutral', resolved: 'neutral' } as const;

export function ConversationStatusBadge({ status }: { status: ConversationListItem['status'] }) {
  return <Badge variant={VARIANT[status]}>{LABEL[status]}</Badge>;
}
