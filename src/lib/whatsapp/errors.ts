import type { AlertSeverity } from '@/lib/alerts';

/**
 * How a failed Cloud API send is understood. `retry` means Meta definitively did NOT send the message and trying again later
 * may work; `permanent` means this message will never go. Anything the table does not know is `permanent` with its raw code
 * shown to the owner: a code we do not understand is never retried by default (a retry of an unknown failure is how duplicate
 * messages happen).
 *
 * The table is assembled from secondary documentation and SDK knowledge, NOT from Meta's own error reference (unreachable when
 * this was written, D-028): treat the classes as a reviewed first draft and extend it from real errors in the owner's logs.
 */

export interface MetaErrorInfo {
  kind: 'retry' | 'permanent';
  /** What the owner reads. Plain words, and what to do about it. */
  message: string;
  /** A condition that needs the owner beyond this one message. */
  alert?: { kind: string; severity: AlertSeverity };
}

const retry = (message: string): MetaErrorInfo => ({ kind: 'retry', message });
const permanent = (message: string, alert?: MetaErrorInfo['alert']): MetaErrorInfo => (alert ? { kind: 'permanent', message, alert } : { kind: 'permanent', message });

const token = { kind: 'whatsapp_token_invalid', severity: 'critical' } as const;

const TABLE: Readonly<Record<number, MetaErrorInfo>> = {
  // -- the 24h window and delivery
  131047: permanent('More than 24 hours since the customer last wrote, so WhatsApp refused a normal message. Send an approved template instead.'),
  131026: permanent('WhatsApp could not deliver this: the number may not be on WhatsApp, may have blocked you, or may be on an old version of the app.'),
  131049: permanent('Meta chose not to deliver this message to protect the customer experience. Try again later, or wait for the customer to message you first.'),
  131021: permanent('The recipient is the same number you are sending from.'),
  131030: permanent('This number is not on the allowed list for your test phone number.'),
  131045: permanent('The sending number is not registered with WhatsApp yet.'),
  131051: permanent('WhatsApp does not support this kind of message.'),
  // -- throttling: Meta did not send it, a later attempt may succeed
  4: retry('Meta is rate-limiting the API. Retrying shortly.'),
  17: retry('Meta is rate-limiting this account. Retrying shortly.'),
  32: retry('Meta is rate-limiting this page. Retrying shortly.'),
  613: retry('Meta is rate-limiting calls. Retrying shortly.'),
  80007: retry('Meta is rate-limiting this WhatsApp account. Retrying shortly.'),
  130429: retry('Meta is throttling this phone number. Retrying shortly.'),
  131056: retry('Too many messages to this customer in a short time. Retrying shortly.'),
  131016: retry('WhatsApp is overloaded right now. Retrying shortly.'),
  // -- the account itself
  131048: permanent('Your number is temporarily restricted because too many of its messages were flagged as spam.', { kind: 'whatsapp_spam_restricted', severity: 'critical' }),
  131031: permanent('Your WhatsApp Business account is locked.', { kind: 'whatsapp_account_locked', severity: 'critical' }),
  131042: permanent('There is a payment problem on your WhatsApp Business account.', { kind: 'whatsapp_payment_problem', severity: 'critical' }),
  131037: permanent('Your display name needs to be approved by WhatsApp before you can send.', { kind: 'whatsapp_display_name', severity: 'warning' }),
  // -- credentials
  190: permanent('Your WhatsApp access token is invalid or has expired. Create a new System User token and update it.', token),
  102: permanent('Your WhatsApp session expired. Create a new System User token and update it.', token),
  131005: permanent('Your access token does not have permission to send messages.', token),
  // -- the request itself
  100: permanent('Meta rejected the request as invalid.'),
  135000: permanent('Meta rejected the request: a parameter was not valid.'),
  131008: permanent('Meta rejected the request: a required field was missing.'),
  131009: permanent('Meta rejected the request: a field had an invalid value.'),
  // -- templates
  132000: permanent('The template needs a different number of values than were given.'),
  132001: permanent('That template does not exist in this language.'),
  132005: permanent('The translated template text is too long.'),
  132007: permanent('The template text breaks WhatsApp’s formatting rules.'),
  132012: permanent('A template value has the wrong format.'),
  132015: permanent('This template is paused by WhatsApp.'),
  132016: permanent('This template has been disabled by WhatsApp.'),
};

/** What Meta said, kept so the owner (and a bug report) sees the real code. */
export interface MetaErrorDetail {
  code: number | null;
  message: string | null;
}

export function classifyMetaError(code: number | null, httpStatus: number): MetaErrorInfo {
  if (code !== null) {
    const known = TABLE[code];
    if (known) return known;
  }
  // Unknown code. HTTP semantics still tell us about throttling; everything else is permanent and shown raw.
  if (httpStatus === 429) return retry('Meta is throttling requests. Retrying shortly.');
  if (httpStatus >= 500) return retry('Meta had a temporary problem. Retrying shortly.');
  return permanent(`Meta refused the message${code === null ? '' : ` (error ${code})`}. This error is not one we recognise: copy the code if you ask for help.`);
}

/**
 * The sentence for an error code Meta reported (a failed delivery in a status webhook): the table's wording when we know the
 * code, otherwise what Meta said. A known code's retry/permanent class is irrelevant here: the message already failed.
 */
export function describeFailureCode(code: number | undefined | null, metaText: string | undefined): string {
  const known = code === undefined || code === null ? undefined : TABLE[code];
  if (known) return known.message;
  return metaText && metaText.length > 0 ? metaText : 'Delivery failed';
}

/** Every code with a table entry (for the exhaustive test and the docs). */
export const KNOWN_META_ERROR_CODES: readonly number[] = Object.keys(TABLE).map(Number);
