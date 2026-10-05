import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { config, proxy } from '@/proxy';

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);

const nonceOf = (csp: string | null) => /'nonce-([^']+)'/.exec(csp ?? '')?.[1];

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

  it('never redirects /login (it is where the redirect goes), cookie or not', () => {
    const response = proxy(request('/login'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});

describe('proxy security headers', () => {
  it('sets the fixed headers and a CSP on a page, and sends the SAME policy on to the render (Next takes the nonce from it)', () => {
    const response = proxy(request('/approvals', 'better-auth.session_token=anything'));
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const csp = response.headers.get('content-security-policy');
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(response.headers.get('x-middleware-override-headers')).toContain('content-security-policy');
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('puts the headers on /login too', () => {
    const csp = proxy(request('/login')).headers.get('content-security-policy');
    expect(nonceOf(csp)).toBeTruthy();
  });

  it('uses a different nonce for every request', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => nonceOf(proxy(request('/login')).headers.get('content-security-policy'))));
    expect(nonces.size).toBe(20);
  });

  it('puts the fixed headers on the redirect as well, and gives it no CSP (it has no document)', () => {
    const response = proxy(request('/'));
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBeNull();
  });

  it('sends no HSTS while the app is served over plain http (the test APP_URL)', () => {
    expect(proxy(request('/login')).headers.get('strict-transport-security')).toBeNull();
  });
});

describe('proxy matcher', () => {
  const [pattern] = config.matcher;
  const matches = (path: string) => new RegExp(`^${pattern}$`).test(path);

  it.each(['/', '/approvals', '/conversations/0190abcd', '/settings', '/settings/audit', '/apiary', '/login'])('runs for the page %s (the redirect itself spares /login; the headers do not)', (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each([
    '/api/events',
    '/api/health',
    '/api/auth/sign-in/email',
    '/api/webhooks/whatsapp',
    '/api/webhooks/telegram',
    '/api/media/abc',
    '/_next/static/chunk.js',
    '/_next/image',
    '/favicon.ico',
  ])('skips %s (route handlers answer 401 themselves, webhooks and health are public, and a proxy would buffer their request bodies)', (path) => {
    expect(matches(path)).toBe(false);
  });
});
