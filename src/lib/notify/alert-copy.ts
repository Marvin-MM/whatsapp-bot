import type { AlertSeverity } from '@/lib/alerts';

/**
 * What an alert says to a human on their phone. Plain words and what to do; never a message body, a name or a phone number (an
 * alert carries only a machine kind and an id). An alert kind with no entry here still gets a readable line.
 */
const COPY: Readonly<Record<string, { title: string; advice: string }>> = {
  whatsapp_token_invalid: { title: 'WhatsApp access token rejected', advice: 'Nothing can be sent or downloaded. Create a new System User token and update WHATSAPP_ACCESS_TOKEN.' },
  whatsapp_spam_restricted: { title: 'WhatsApp restricted your number', advice: 'Too many messages were flagged as spam. Stop sending and review in WhatsApp Manager.' },
  whatsapp_account_locked: { title: 'WhatsApp locked your account', advice: 'Check WhatsApp Manager for the reason.' },
  whatsapp_payment_problem: { title: 'WhatsApp payment problem', advice: 'Fix the payment method in Meta Business Settings.' },
  whatsapp_display_name: { title: 'Display name not approved', advice: 'WhatsApp must approve your display name before you can send.' },
  message_unknown: { title: 'A message may not have been sent', advice: 'Check your phone, then mark it sent or send it again.' },
  webhook_event_stuck: { title: 'A WhatsApp event is stuck', advice: 'Is the worker running? Check Settings.' },
  webhook_unparseable: { title: 'Meta sent something unreadable', advice: 'Stored safely; see Settings.' },
  account_offboarded: { title: 'Your WhatsApp account was disconnected', advice: 'Reconnect it in the WhatsApp Business app.' },
  account_reconnected: { title: 'Your WhatsApp account is connected again', advice: '' },
  phone_quality_degraded: { title: 'Your number’s quality rating dropped', advice: 'Slow down on marketing messages.' },
  window_expiring: { title: 'A reply window closes soon', advice: 'Reply within the hour, or only a template can be sent afterwards.' },
  token_check_failed: { title: 'Could not verify the WhatsApp token', advice: 'See Settings for the details.' },
  task_overdue: { title: 'A task is overdue', advice: 'Open Tasks to finish it or move the time.' },
  analysis_failed: { title: 'A conversation summary could not be updated', advice: 'Replies and your own tasks still work. It is tried again after your next reply.' },
  ai_key_invalid: { title: 'The AI key was rejected', advice: 'Drafts and summaries are paused until GROQ_API_KEY is fixed.' },
  draft_generation_failed: { title: 'A draft could not be written', advice: 'Open Approvals and press Try again, or reply yourself.' },
};

/** Where the link in an alert should land: the page that has the thing to do. */
export function alertPath(kind: string): string {
  switch (kind) {
    case 'task_overdue':
      return '/tasks';
    case 'draft_generation_failed':
      return '/approvals';
    case 'window_expiring':
      return '/conversations?filter=needs_reply';
    case 'message_unknown':
    case 'message_requeued':
    case 'analysis_failed':
      return '/settings/problems';
    default:
      return '/settings';
  }
}

const PREFIX: Record<AlertSeverity, string> = { critical: '🔴', warning: '🟠', info: 'ℹ️' };

export function alertText(alert: { kind: string; severity: AlertSeverity }, link: string): string {
  const copy = COPY[alert.kind];
  const title = copy?.title ?? `Alert: ${alert.kind.replaceAll('_', ' ')}`;
  return [`${PREFIX[alert.severity]} ${title}`, copy?.advice, link].filter((line): line is string => line !== undefined && line !== '').join('\n');
}
