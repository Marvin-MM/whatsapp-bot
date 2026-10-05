import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { applyBaseHeaders, buildCsp, createNonce } from '@/lib/security/headers';

/**
 * Two jobs, neither of them authorization:
 *
 *  1. Redirects unauthenticated browser navigation to /login. It only checks that a session cookie exists. Pages, server actions and route
 *     handlers each verify the session themselves (Server Functions skip proxy on excluded paths).
 *  2. Sets the page security headers, including a Content-Security-Policy with a fresh nonce per request (Next reads the nonce from the request's
 *     CSP header and puts it on its own scripts and styles).
 *
 * /api/* is excluded on purpose, for two reasons: route handlers answer 401 JSON themselves instead of an HTML redirect, and a proxy makes Next
 * buffer every request body in memory (up to 10 MB by default) before the route sees it, which would undo the webhook's own 3 MiB cap. API
 * responses get their (fixed) security headers from next.config.ts instead.
 */
export function proxy(request: NextRequest) {
  const env = getEnv();
  const https = new URL(env.APP_URL).protocol === 'https:';

  if (request.nextUrl.pathname !== '/login' && !getSessionCookie(request)) {
    const login = new URL('/login', request.url);
    const target = `${request.nextUrl.pathname}${request.nextUrl.search}`;
    if (target !== '/') login.searchParams.set('next', target);
    const redirect = NextResponse.redirect(login);
    applyBaseHeaders(redirect.headers, { https });
    return redirect;
  }

  const csp = buildCsp({ nonce: createNonce(), development: env.NODE_ENV === 'development', https });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  applyBaseHeaders(response.headers, { https });
  return response;
}

export const config = {
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico).*)'],
};
