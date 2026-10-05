/**
 * Text that came from a person (a customer, or the owner's own messages) is DATA inside a prompt, never part of its structure.
 * Angle brackets are replaced by look-alikes so such text can neither close a prompt tag nor open a new one (spec 9.2), and one
 * message is cut at 2,000 characters so a single long message cannot crowd out the rest of the prompt.
 */

export const MAX_MESSAGE_CHARS = 2000;

export function sanitizeForPrompt(text: string, maxChars: number = MAX_MESSAGE_CHARS): string {
  const cleaned = text.replaceAll('<', '‹').replaceAll('>', '›').replace(/\u0000/g, '');
  if (cleaned.length <= maxChars) return cleaned;
  // Never cut in the middle of a surrogate pair (an emoji): that would leave an invalid string.
  const cut = cleaned.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
}
