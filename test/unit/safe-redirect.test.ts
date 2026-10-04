import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from '@/lib/safe-redirect';

describe('safeRedirectPath (open-redirect guard for ?next=)', () => {
  it.each(['/', '/approvals', '/conversations/0190abcd', '/tasks?due=today', '/settings#audit'])('allows the local path %s', (path) => {
    expect(safeRedirectPath(path)).toBe(path);
  });

  it.each([
    'https://evil.example',
    'http://evil.example/path',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'evil.example',
    'approvals',
    '/ok\nSet-Cookie: x=1',
    '/ok\r\nLocation: https://evil.example',
    '',
  ])('rejects %j and falls back', (target) => {
    expect(safeRedirectPath(target)).toBe('/');
  });

  it('falls back for null and undefined, with a custom fallback', () => {
    expect(safeRedirectPath(null)).toBe('/');
    expect(safeRedirectPath(undefined, '/approvals')).toBe('/approvals');
  });
});
