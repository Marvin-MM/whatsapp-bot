import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSignature, safeEqualStrings, verifySignature } from '@/lib/whatsapp/signature';
import { fixtureBytes } from '../helpers/fixtures';

const SECRET = 'app-secret-for-tests';
const bytes = (text: string) => new TextEncoder().encode(text);
const signHex = (secret: string, body: Uint8Array) => createHmac('sha256', secret).update(body).digest('hex');

describe('computeSignature', () => {
  it('matches the published HMAC-SHA256 test vector (key "key", the quick-brown-fox message)', () => {
    expect(computeSignature('key', bytes('The quick brown fox jumps over the lazy dog'))).toBe(
      'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });
});

describe('verifySignature', () => {
  const body = fixtureBytes('text-message');

  it('accepts a correct signature over the exact bytes', () => {
    expect(verifySignature(SECRET, body, `sha256=${signHex(SECRET, body)}`)).toBe(true);
  });

  it('accepts uppercase hex (hex is case-insensitive)', () => {
    expect(verifySignature(SECRET, body, `sha256=${signHex(SECRET, body).toUpperCase()}`)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifySignature(SECRET, body, `sha256=${signHex('another-secret', body)}`)).toBe(false);
  });

  it('rejects a body that was altered by a single byte', () => {
    const altered = new Uint8Array(body);
    altered[10] = (altered[10] ?? 0) ^ 1;
    expect(verifySignature(SECRET, altered, `sha256=${signHex(SECRET, body)}`)).toBe(false);
  });

  it('verifies the RAW bytes: a pretty-printed or re-serialised copy of the same JSON must NOT verify', () => {
    const signedOverRaw = `sha256=${signHex(SECRET, body)}`;
    const reserialised = bytes(JSON.stringify(JSON.parse(new TextDecoder().decode(body)), null, 4));
    expect(reserialised.length).not.toBe(body.length);
    expect(verifySignature(SECRET, reserialised, signedOverRaw)).toBe(false);
    // And the other direction: a signature computed over a re-serialisation does not verify the raw bytes.
    expect(verifySignature(SECRET, body, `sha256=${signHex(SECRET, reserialised)}`)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['no prefix', signHex(SECRET, fixtureBytes('text-message'))],
    ['wrong algorithm prefix', `sha1=${signHex(SECRET, fixtureBytes('text-message')).slice(0, 40)}`],
    ['too short', 'sha256=abcd'],
    ['too long', `sha256=${signHex(SECRET, fixtureBytes('text-message'))}00`],
    ['non-hex characters', `sha256=${'z'.repeat(64)}`],
    ['64 chars but with a space', `sha256=${' '.repeat(64)}`],
    ['unicode', 'sha256=☃☃☃'],
    ['enormous header', `sha256=${'a'.repeat(100_000)}`],
  ])('rejects a %s header without throwing', (_label, header) => {
    expect(verifySignature(SECRET, body, header as string | null | undefined)).toBe(false);
  });

  it('handles an empty body', () => {
    const empty = new Uint8Array(0);
    expect(verifySignature(SECRET, empty, `sha256=${signHex(SECRET, empty)}`)).toBe(true);
  });
});

describe('safeEqualStrings', () => {
  it('is true only for identical strings', () => {
    expect(safeEqualStrings('verify-token', 'verify-token')).toBe(true);
    expect(safeEqualStrings('verify-token', 'verify-tokeN')).toBe(false);
  });

  it('treats different lengths as unequal without throwing', () => {
    expect(safeEqualStrings('short', 'a-much-longer-value')).toBe(false);
    expect(safeEqualStrings('', 'x')).toBe(false);
    expect(safeEqualStrings('', '')).toBe(true);
  });
});
