import { maskPhone } from '@/lib/logger';

/**
 * The words of the autopilot's Telegram message, and the data its two buttons carry. Pure, so the exact text and the exact callback format are
 * tested without a bot. The message shows the REPLY that is about to go out (an AI-written text), and the customer's first name or handle:
 * the owner cannot cancel what they cannot read. It never shows the customer's own messages (D-096).
 */

const MAX_REPLY_CHARS = 1500;
const MAX_NAME_CHARS = 60;

export interface Nameable {
  displayName: string | null;
  username: string | null;
  phoneE164: string | null;
  bsuid: string | null;
}

/** A name, a handle, or the last four digits of a number: never a whole phone number in a chat that is not this system's own screen. */
export function telegramName(contact: Nameable): string {
  const named = contact.displayName?.trim() || (contact.username ? `@${contact.username}` : '');
  if (named) return named.slice(0, MAX_NAME_CHARS);
  if (contact.phoneE164) return maskPhone(contact.phoneE164);
  return 'a customer';
}

const clip = (text: string) => (text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text);

export function waitText(seconds: number): string {
  if (seconds < 120) return `${Math.max(1, Math.round(seconds))} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function scheduledText(input: { name: string; reply: string; delaySeconds: number }): string {
  return `🤖 Autopilot will reply to ${input.name} in ${waitText(input.delaySeconds)}:\n\n${clip(input.reply)}\n\nCancel to read it yourself in Approvals, or Send now.`;
}

export function retiredText(input: { name: string; reply: string; note: string }): string {
  return `🤖 ${input.note}\n${input.name}\n\n${clip(input.reply)}`;
}

// ---------------------------------------------------------------------------------------------------------- the buttons

export type AutopilotAction = 'cancel' | 'send';

const CALLBACK = /^ap:(cancel|send):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** At most 64 bytes (Telegram's limit): `ap:` + action + `:` + a 36-character id is at most 46. */
export function callbackData(action: AutopilotAction, draftId: string): string {
  return `ap:${action}:${draftId}`;
}

/** Anything that is not exactly one of our two callbacks is null: a stranger's data never becomes an action. */
export function parseCallbackData(data: string): { action: AutopilotAction; draftId: string } | null {
  const match = CALLBACK.exec(data);
  if (!match) return null;
  return { action: match[1] as AutopilotAction, draftId: match[2] ?? '' };
}
