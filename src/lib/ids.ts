import { randomBytes } from 'node:crypto';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * UUID v7: 48-bit unix-ms timestamp, then random bits. Ids created in later
 * milliseconds sort after earlier ones, which keeps primary-key inserts clustered.
 * Node has no built-in v7 and Postgres 16 has no `uuidv7()`.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) {
    bytes.writeUInt8(Math.floor(nowMs / 2 ** (8 * (5 - i))) % 256, i);
  }
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidv7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}
