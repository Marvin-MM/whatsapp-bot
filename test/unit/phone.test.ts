import { describe, expect, it } from 'vitest';
import { classifyIdentifier, digitsOf, isBsuid, normalizePhone, sameNumber } from '@/lib/whatsapp/phone';

describe('normalizePhone', () => {
  it.each([
    ['256700123456', '+256700123456'],
    ['+256 700 123 456', '+256700123456'],
    ['(256) 700-123-456', '+256700123456'],
    ['+1 (650) 555-1234', '+16505551234'],
  ])('normalises %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'abc', '12345', '1'.repeat(16), 'UG.13491208655302741918'])('rejects %j', (input) => {
    expect(normalizePhone(input as string | null | undefined)).toBeNull();
  });
});

describe('BSUID and identifier classification', () => {
  it.each(['UG.13491208655302741918', 'US.13491208655302741918', 'US.ENT.11815799212886844830', 'BR.1A2B3C4D5E6F7G8H9I0J'])(
    'recognises the BSUID %s',
    (value) => {
      expect(isBsuid(value)).toBe(true);
      expect(classifyIdentifier(value)).toBe('bsuid');
    },
  );

  it.each(['256700123456', '+256700123456', '256 700 123 456'])('classifies %s as a phone', (value) => {
    expect(classifyIdentifier(value)).toBe('phone');
  });

  it.each(['', undefined, null, 'hello', 'ug.123', 'UG.', '12'])('classifies %j as unknown', (value) => {
    expect(classifyIdentifier(value as string | null | undefined)).toBe('unknown');
  });
});

describe('digitsOf and sameNumber', () => {
  it('strips the plus for the Cloud API `to` field', () => {
    expect(digitsOf('+256700123456')).toBe('256700123456');
  });

  it('compares numbers ignoring formatting', () => {
    expect(sameNumber('256700123456', '+256 700 123 456')).toBe(true);
    expect(sameNumber('256700123456', '256700123457')).toBe(false);
  });

  it('is false when either side is not a phone (never matches two unknowns)', () => {
    expect(sameNumber(null, null)).toBe(false);
    expect(sameNumber('UG.123', 'UG.123')).toBe(false);
  });
});
