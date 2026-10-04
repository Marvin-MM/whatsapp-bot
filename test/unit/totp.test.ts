import { describe, expect, it } from 'vitest';
import { base32Decode, secretFromOtpauthUri, totp } from '@/lib/totp';

// RFC 6238 appendix B: secret is the ASCII string "12345678901234567890" (SHA1).
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('decodes the RFC 4648 test vectors', () => {
    expect(base32Decode('MY======').toString()).toBe('f');
    expect(base32Decode('MZXW6===').toString()).toBe('foo');
    expect(base32Decode('MZXW6YTBOI======').toString()).toBe('foobar');
    expect(base32Decode('mzxw6ytboi').toString()).toBe('foobar');
  });

  it('decodes the RFC 6238 shared secret', () => {
    expect(base32Decode(RFC_SECRET_BASE32).toString()).toBe('12345678901234567890');
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('MZXW6!')).toThrow(/invalid base32/);
  });
});

describe('totp (RFC 6238 appendix B, SHA1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('time %d -> %s', (seconds, expected) => {
    expect(totp(RFC_SECRET_BASE32, { timeMs: seconds * 1000, digits: 8 })).toBe(expected);
  });

  it('produces the 6-digit code the authenticator apps show (last 6 digits for this vector)', () => {
    expect(totp(RFC_SECRET_BASE32, { timeMs: 59_000 })).toBe('287082');
  });

  it('is stable within a 30 second window and changes after it', () => {
    const base = 1_700_000_010_000; // 1_700_000_010 s is 30s-aligned minus 0
    const window = Math.floor(base / 30_000) * 30_000;
    expect(totp(RFC_SECRET_BASE32, { timeMs: window })).toBe(totp(RFC_SECRET_BASE32, { timeMs: window + 29_999 }));
    expect(totp(RFC_SECRET_BASE32, { timeMs: window })).not.toBe(totp(RFC_SECRET_BASE32, { timeMs: window + 30_000 }));
  });

  it('keeps leading zeros', () => {
    expect(totp(RFC_SECRET_BASE32, { timeMs: 1111111109 * 1000, digits: 8 })).toHaveLength(8);
  });
});

describe('secretFromOtpauthUri', () => {
  it('extracts the secret parameter', () => {
    expect(secretFromOtpauthUri('otpauth://totp/WhatsApp%20Assistant:owner%40example.test?secret=ABC234&issuer=x&digits=6')).toBe(
      'ABC234',
    );
  });

  it('throws when there is no secret', () => {
    expect(() => secretFromOtpauthUri('otpauth://totp/x?issuer=y')).toThrow(/no secret/);
  });
});
