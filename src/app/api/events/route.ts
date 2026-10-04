import { checkOwner } from '@/lib/auth-guard';
import { getDashboardHub } from '@/lib/realtime/hub';
import { eventStreamResponse } from '@/lib/realtime/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The dashboard's live event stream. Authenticated by the route itself (proxy.ts only redirects), and re-authenticated
 * periodically so a signed-out or revoked session stops receiving events. Payloads are IDs and minimal fields only.
 */
export async function GET(request: Request): Promise<Response> {
  const check = await checkOwner(request.headers);
  if (!check.ok) return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  return eventStreamResponse({
    hub: getDashboardHub(),
    signal: request.signal,
    recheck: async () => (await checkOwner(request.headers)).ok,
  });
}
