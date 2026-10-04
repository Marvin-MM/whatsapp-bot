import { createHmac } from 'node:crypto';

/** RFC 6238 TOTP (RFC 4226 HOTP over a time counter). Used by the owner seed script and tests. */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`invalid base32 character: ${char}`);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

export interface TotpOptions {
  timeMs?: number;
  digits?: number;
  periodSeconds?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

export function totp(secretBase32: string, options: TotpOptions = {}): string {
  const { timeMs = Date.now(), digits = 6, periodSeconds = 30, algorithm = 'sha1' } = options;
  const counter = BigInt(Math.floor(timeMs / 1000 / periodSeconds));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const hmac = createHmac(algorithm, base32Decode(secretBase32)).update(message).digest();
  const offset = hmac.readUInt8(hmac.length - 1) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Extracts the base32 secret from an `otpauth://totp/...?secret=...` URI. */
export function secretFromOtpauthUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error('otpauth URI has no secret parameter');
  return secret;
}
