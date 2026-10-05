import { isWindowOpen } from '@/lib/conversations/window';

/**
 * The pure rules a message must pass before it may be queued for sending (spec 6.5). No I/O: every input is passed in, so
 * each rule is unit-tested in isolation and the same function serves the owner's composer, an approved draft and (Phase 7)
 * the autopilot recheck. A refusal carries a stable `code` (for tests and the UI) and a sentence the owner can act on.
 */

/** WhatsApp's limit for the body of a text message. */
export const MAX_TEXT_LENGTH = 4096;

/** A fact the drafter did not have becomes `[[a placeholder]]` and BLOCKS sending until the owner replaces it. */
export const PLACEHOLDER_PATTERN = /\[\[[^\]]*\]\]/;

export type PrecheckCode =
  | 'sending_paused'
  | 'no_recipient'
  | 'empty_message'
  | 'message_too_long'
  | 'placeholder_unresolved'
  | 'window_closed'
  | 'draft_not_open'
  | 'draft_stale';

export type PrecheckResult = { ok: true } | { ok: false; code: PrecheckCode; message: string };

export interface PrecheckInput {
  now: Date;
  /** Kill switch. */
  sendingPaused: boolean;
  /** `conversations.window_expires_at`: the 24h window, maintained in one place. */
  windowExpiresAt: Date | null;
  recipient: { phone: string | null; bsuid: string | null };
  message: { kind: 'text'; content: string } | { kind: 'template'; renderedContent: string };
  /** Present when the message is a draft being approved. */
  draft?: {
    status: 'pending' | 'scheduled' | 'approved' | 'edited' | 'rejected' | 'superseded' | 'cancelled' | 'failed';
    /** The customer wrote after this draft was generated, so it may no longer answer them. */
    stale: boolean;
    /** The owner has seen the staleness warning and chose to send anyway. */
    overrideStale: boolean;
  };
}

const refuse = (code: PrecheckCode, message: string): PrecheckResult => ({ ok: false, code, message });

/**
 * Order is deliberate: the kill switch outranks everything, then whether anyone can be reached, then the content, then the
 * window last (the most likely reason for a refusal gets the most useful message).
 */
export function precheck(input: PrecheckInput): PrecheckResult {
  if (input.sendingPaused) return refuse('sending_paused', 'Sending is paused. Turn it back on in Settings to send.');
  if (!input.recipient.phone && !input.recipient.bsuid) return refuse('no_recipient', 'This customer has no phone number or WhatsApp ID on file, so there is nobody to send to.');

  if (input.draft) {
    if (input.draft.status !== 'pending' && input.draft.status !== 'scheduled') {
      return refuse('draft_not_open', 'This draft was already handled (approved, rejected or replaced).');
    }
    if (input.draft.stale && !input.draft.overrideStale) {
      return refuse('draft_stale', 'The customer wrote again after this draft was made. Check it still answers them, or choose "send anyway".');
    }
  }

  const content = input.message.kind === 'text' ? input.message.content : input.message.renderedContent;
  if (content.trim() === '') return refuse('empty_message', 'The message is empty.');
  if (content.length > MAX_TEXT_LENGTH) return refuse('message_too_long', `The message is ${content.length} characters; WhatsApp allows ${MAX_TEXT_LENGTH}.`);
  if (PLACEHOLDER_PATTERN.test(content)) return refuse('placeholder_unresolved', 'The message still has a [[placeholder]] for something we did not know. Replace it before sending.');

  // Only an approved template may be sent outside the window; free text may not.
  if (input.message.kind === 'text' && !isWindowOpen(input.windowExpiresAt, input.now)) {
    return refuse('window_closed', 'More than 24 hours since the customer last wrote: WhatsApp only allows an approved template now.');
  }
  return { ok: true };
}
