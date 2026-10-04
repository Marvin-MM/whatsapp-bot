export interface Nameable {
  displayName: string | null;
  username: string | null;
  phoneE164: string | null;
  bsuid: string | null;
}

/**
 * What to call a customer. A name the owner or the customer gave beats a handle, a handle beats a number, and a number
 * beats nothing. A customer reached only by BSUID has no phone and may have no name: still shown, never blank.
 */
export function displayName(contact: Nameable): string {
  return contact.displayName?.trim() || (contact.username ? `@${contact.username}` : null) || contact.phoneE164 || 'Unknown customer';
}

/** The identifier line under the name, when it adds something the name does not already say. */
export function secondaryLine(contact: Nameable): string | null {
  const name = displayName(contact);
  const parts = [contact.phoneE164, contact.username ? `@${contact.username}` : null].filter((part): part is string => part !== null && part !== name);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function initials(name: string): string {
  const words = name.replace(/^[@+]/, '').split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0]?.[0], words[1]?.[0]] : [words[0]?.[0], words[0]?.[1]];
  const text = letters.filter((letter): letter is string => Boolean(letter)).join('');
  return text === '' ? '?' : text.toUpperCase();
}

/** Escapes LIKE wildcards so a search for `50%` or `a_b` means those characters, not a pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
