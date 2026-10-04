import { z } from 'zod';

/**
 * Keyset pagination cursor: the sort key of the last row seen. Offsets drift when rows arrive while the owner pages;
 * a (time, id) key does not. `t` is null for rows that sort last (a conversation with no messages yet).
 */
export interface Cursor {
  t: string | null;
  id: string;
}

const cursorSchema = z.object({ t: z.iso.datetime({ offset: true }).nullable(), id: z.uuid() });

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** A cursor comes from the URL, so it is untrusted input: anything malformed is treated as "no cursor", never an error. */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw || raw.length > 400) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
