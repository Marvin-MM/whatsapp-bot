import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from '@/proxy';

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);

describe('proxy (cookie-presence redirect only)', () => {
  it('redirects an unauthenticated request for / to /login', () => {
    const response = proxy(request('/'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('remembers where the visitor was headed, including the query string', () => {
    const response = proxy(request('/approvals?filter=old'));
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/approvals?filter=old');
  });

  it('lets a request with a session cookie through', () => {
    const response = proxy(request('/approvals', 'better-auth.session_token=anything'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('is only a redirect: it does not validate the cookie (pages and actions do)', () => {
    const response = proxy(request('/', 'better-auth.session_token=forged'));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('proxy matcher', () => {
  const [pattern] = config.matcher;
  const matches = (path: string) => new RegExp(`^${pattern}$`).test(path);

  it.each(['/', '/approvals', '/conversations/0190abcd', '/settings', '/apiary'])('runs for the dashboard path %s', (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each([
    '/login',
    '/api/events',
    '/api/health',
    '/api/auth/sign-in/email',
    '/api/webhooks/whatsapp',
    '/api/webhooks/telegram',
    '/api/media/abc',
    '/_next/static/chunk.js',
    '/_next/image',
    '/favicon.ico',
  ])('skips %s (route handlers answer 401 themselves; webhooks and health are public)', (path) => {
    expect(matches(path)).toBe(false);
  });
});
