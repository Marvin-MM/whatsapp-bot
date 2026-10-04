import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Redirects unauthenticated browser navigation to /login. This is NOT an authorization layer:
 * it only checks that a session cookie exists. Pages, server actions and route handlers each
 * verify the session themselves (Server Functions skip proxy on excluded paths).
 *
 * /api/* is excluded on purpose: route handlers answer 401 JSON themselves instead of an HTML redirect.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();

  const login = new URL('/login', request.url);
  const target = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (target !== '/') login.searchParams.set('next', target);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!api/|login|_next/static|_next/image|favicon.ico).*)'],
};
