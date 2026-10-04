import { checkOwner } from '@/lib/auth-guard';
import { serveMedia } from '@/lib/media-serve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Customer media for the owner's browser. Authenticated here, not in proxy.ts (which only redirects): a route handler that
 * serves private data verifies the session itself. A 401 is JSON-free and body-free: it must never hint at what exists.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const check = await checkOwner(request.headers);
  if (!check.ok) return new Response(null, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  const { id } = await context.params;
  return serveMedia(request, id);
}
