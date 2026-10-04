import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRange } from '@/lib/media-serve';
import { MEDIA_MAX_BYTES, checkMime, maxBytesFor, mediaRelativePath, normalizeMime, resolveMediaPath, verifySha256 } from '@/lib/whatsapp/media';

describe('normalizeMime', () => {
  it('lowercases and drops parameters', () => {
    expect(normalizeMime('Audio/OGG; codecs=opus')).toBe('audio/ogg');
    expect(normalizeMime(' image/jpeg ')).toBe('image/jpeg');
  });

  it.each([null, undefined, '', 'nonsense', 'a/b/c', 'image/', '/png', 'text/html<script>'])('rejects %s', (value) => {
    expect(normalizeMime(value as string | null | undefined)).toBeNull();
  });
});

describe('checkMime: only an allowlist is ever stored', () => {
  it('accepts the types WhatsApp really sends, under the extension WE choose', () => {
    expect(checkMime('image/jpeg', 'image')).toEqual({ ok: true, mime: 'image/jpeg', kind: 'image', extension: 'jpg' });
    expect(checkMime('audio/ogg; codecs=opus', 'audio')).toMatchObject({ ok: true, extension: 'ogg' });
    expect(checkMime('application/pdf', 'document')).toMatchObject({ ok: true, extension: 'pdf' });
    expect(checkMime('video/mp4', 'video')).toMatchObject({ ok: true, extension: 'mp4' });
    expect(checkMime('image/webp', 'sticker')).toMatchObject({ ok: true, kind: 'sticker', extension: 'webp' });
  });

  it.each(['text/html', 'image/svg+xml', 'application/javascript', 'application/x-msdownload', 'application/octet-stream', 'text/xml', 'application/zip', 'application/x-sh'])(
    'refuses %s: it would be a script or malware vector in the owner’s browser',
    (mime) => {
      for (const kind of ['image', 'document', 'audio', 'video', 'sticker'] as const) {
        expect(checkMime(mime, kind)).toEqual({ ok: false, reason: 'mime_not_allowed' });
      }
    },
  );

  it('refuses a file whose real type contradicts what the message claimed', () => {
    expect(checkMime('application/pdf', 'image')).toEqual({ ok: false, reason: 'kind_mismatch' });
    expect(checkMime('image/png', 'audio')).toEqual({ ok: false, reason: 'kind_mismatch' });
    expect(checkMime('image/jpeg', 'sticker')).toEqual({ ok: false, reason: 'kind_mismatch' });
  });

  it('reports a missing type', () => {
    expect(checkMime(null, 'image')).toEqual({ ok: false, reason: 'mime_missing' });
  });

  it('has a ceiling for every kind', () => {
    for (const kind of ['image', 'video', 'audio', 'document', 'sticker'] as const) expect(maxBytesFor(kind)).toBe(MEDIA_MAX_BYTES[kind]);
    expect(MEDIA_MAX_BYTES.sticker).toBeLessThan(MEDIA_MAX_BYTES.image);
  });
});

describe('verifySha256', () => {
  const bytes = new TextEncoder().encode('the file');
  const digest = createHash('sha256').update(bytes).digest();

  it('accepts the digest as hex or as base64', () => {
    expect(verifySha256(bytes, digest.toString('hex'))).toBe('match');
    expect(verifySha256(bytes, digest.toString('hex').toUpperCase())).toBe('match');
    expect(verifySha256(bytes, digest.toString('base64'))).toBe('match');
  });

  it('flags bytes that are not the file Meta described', () => {
    expect(verifySha256(new TextEncoder().encode('another file'), digest.toString('hex'))).toBe('mismatch');
    expect(verifySha256(bytes, 'a'.repeat(64))).toBe('mismatch');
  });

  it('cannot verify what it is not given', () => {
    expect(verifySha256(bytes, undefined)).toBe('not_provided');
    expect(verifySha256(bytes, '  ')).toBe('not_provided');
  });
});

describe('mediaRelativePath and resolveMediaPath', () => {
  it('lays files out by UTC year/month with an id of ours and an extension of ours', () => {
    expect(mediaRelativePath(new Date('2026-10-04T23:59:59Z'), '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', 'jpg')).toBe('2026/10/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jpg');
    expect(mediaRelativePath(new Date('2027-01-01T00:00:00Z'), 'x', 'pdf')).toBe('2027/01/x.pdf');
  });

  const root = '/srv/app/data/media';

  it('resolves a normal stored path inside the root', () => {
    expect(resolveMediaPath(root, '2026/10/a.jpg')).toBe('/srv/app/data/media/2026/10/a.jpg');
  });

  it.each([
    ['parent traversal', '../secret'],
    ['nested traversal', '2026/../../secret'],
    ['deep traversal', '2026/10/../../../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['empty', ''],
    ['current directory', '.'],
    ['NUL byte', '2026/10/a.jpg\0.png'],
    ['backslash', '2026\\10\\a.jpg'],
    ['windows traversal', '..\\secret'],
    ['encoded-looking dot segments are literal names, not traversal, but a bare .. is refused', '..'],
  ])('refuses %s', (_name, stored) => {
    expect(() => resolveMediaPath(root, stored)).toThrow('invalid media path');
  });

  it('refuses a path that normalises to the root itself or escapes through a sibling prefix', () => {
    expect(() => resolveMediaPath(root, '2026/..')).toThrow('invalid media path');
    // "/srv/app/data/media-evil" shares the textual prefix of the root but is outside it.
    expect(() => resolveMediaPath(root, '../media-evil/x.jpg')).toThrow('invalid media path');
  });
});

describe('parseRange', () => {
  it('serves everything when there is no header', () => {
    expect(parseRange(null, 100)).toBeNull();
  });

  it('parses start-end, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 });
  });

  it('clamps an end beyond the file (RFC 7233: a last-byte-pos past the end is valid, not an error)', () => {
    expect(parseRange('bytes=50-5000', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=0-9999999999999999999999', 100)).toEqual({ start: 0, end: 99 });
  });

  it.each(['bytes=100-', 'bytes=200-300', 'bytes=10-5', 'bytes=-0', 'bytes=-', 'bytes=0-1,5-9', 'items=0-1', 'bytes=a-b', 'bytes=9999999999999999999999-'])('rejects %s', (header) => {
    expect(parseRange(header, 100)).toBe('invalid');
  });

  it('cannot range an empty file', () => {
    expect(parseRange('bytes=0-0', 0)).toBe('invalid');
  });
});
