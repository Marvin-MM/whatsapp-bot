import { describe, expect, it } from 'vitest';
import { isUuidv7, uuidv7 } from '@/lib/ids';

function embeddedTimestamp(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 / variant 10 ids', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = uuidv7();
      expect(isUuidv7(id)).toBe(true);
      expect(id).toHaveLength(36);
      expect(id[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
  });

  it('embeds the millisecond timestamp it was given', () => {
    const at = Date.UTC(2026, 9, 4, 12, 30, 15, 123);
    expect(embeddedTimestamp(uuidv7(at))).toBe(at);
  });

  it('sorts lexicographically by creation time', () => {
    const base = Date.UTC(2026, 0, 1);
    const ids = [3, 1, 4, 0, 2].map((offset) => uuidv7(base + offset * 1000));
    const sorted = [...ids].sort();
    expect(sorted.map(embeddedTimestamp)).toEqual([0, 1, 2, 3, 4].map((offset) => base + offset * 1000));
  });

  it('does not collide within one millisecond', () => {
    const at = Date.now();
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(at)));
    expect(ids.size).toBe(5000);
  });

  it('rejects non-v7 uuids', () => {
    expect(isUuidv7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isUuidv7('not-a-uuid')).toBe(false);
  });
});
