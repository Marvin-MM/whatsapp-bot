import { classifyIdentifier, isBsuid, sameNumber } from '@/lib/whatsapp/phone';
import type { WebhookContact, WebhookMessage } from '@/lib/whatsapp/webhook-schema';
import type { Identity } from './contacts';

/** Which of the payload's contact entries describes the sender (there is normally exactly one). */
export function senderEntry(message: WebhookMessage, entries: readonly WebhookContact[] | undefined): WebhookContact | undefined {
  if (!entries || entries.length === 0) return undefined;
  const byId = entries.find(
    (entry) =>
      (message.from_user_id !== undefined && entry.user_id === message.from_user_id) ||
      (message.from !== undefined && (entry.wa_id === message.from || entry.user_id === message.from)),
  );
  return byId ?? (entries.length === 1 ? entries[0] : undefined);
}

/** `from` may hold a phone-based id OR a BSUID, and may be absent altogether (username users). */
export function inboundIdentity(message: WebhookMessage, entries: readonly WebhookContact[] | undefined): Identity {
  const entry = senderEntry(message, entries);
  const fromKind = classifyIdentifier(message.from);
  return {
    bsuid: message.from_user_id ?? entry?.user_id ?? (fromKind === 'bsuid' ? message.from : undefined),
    phone: fromKind === 'phone' ? message.from : entry?.wa_id,
    profileName: entry?.profile?.name,
    username: entry?.profile?.username,
  };
}

/**
 * Who the owner wrote to. The official echo shape names the recipient (`to`, or a BSUID in `to_user_id`); the open-source
 * fixtures omit it. When no recipient is named there is nothing to attach the message to, and guessing would file the
 * owner's words in the wrong customer's thread, so the caller parks it and raises an alert.
 */
export function echoCounterpart(message: WebhookMessage, ownNumber: string | null): Identity | null {
  const named = [message.to, message.recipient_id];
  const phone = named.find((value) => classifyIdentifier(value) === 'phone' && !sameNumber(value, ownNumber));
  const bsuid = [message.to_user_id, message.recipient_user_id, ...named.filter((value): value is string => value !== undefined && isBsuid(value))].find(
    (value) => value !== undefined,
  );
  if (phone === undefined && bsuid === undefined) return null;
  return { bsuid, phone };
}
