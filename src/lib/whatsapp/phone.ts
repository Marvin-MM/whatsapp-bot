/**
 * WhatsApp identifiers come in two forms and either may be missing (spec 6.3, BSUID rollout):
 *   - a phone-number-based id (`wa_id`, `from`): digits, no plus, e.g. "256700123456"
 *   - a business-scoped user id (BSUID, `user_id`): country code + "." + alphanumerics, e.g. "UG.13491208655302741918"
 *     (parent BSUIDs contain an "ENT" segment: "US.ENT.11815799212886844830")
 */

const BSUID_PATTERN = /^[A-Z]{2}\.[A-Za-z0-9.]{1,140}$/;

export type IdentifierKind = 'phone' | 'bsuid' | 'unknown';

export function isBsuid(value: string): boolean {
  return BSUID_PATTERN.test(value);
}

/** Normalises a phone-ish value to `+digits` (7-15 digits), or null. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

/** Classifies an identifier whose kind is not guaranteed (`from`, `to`, `recipient_id` may hold either). */
export function classifyIdentifier(value: string | null | undefined): IdentifierKind {
  if (!value) return 'unknown';
  if (isBsuid(value)) return 'bsuid';
  if (/^\+?[\d\s()-]+$/.test(value) && normalizePhone(value)) return 'phone';
  return 'unknown';
}

/** Digits only, as the Cloud API wants in `to` (no plus sign). */
export function digitsOf(e164: string): string {
  return e164.replace(/\D/g, '');
}

/** True when two phone-ish values are the same number, ignoring formatting. */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  return left !== null && left === right;
}
