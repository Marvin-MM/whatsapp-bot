import { handleWebhookPost, handleWebhookVerify } from '@/lib/whatsapp/webhook-intake';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Meta's subscription handshake. Public by design: protected by the verify token. */
export function GET(request: Request): Response {
  return handleWebhookVerify(request);
}

/** Event delivery. Public by design: protected by the X-Hub-Signature-256 HMAC, verified before anything else. */
export async function POST(request: Request): Promise<Response> {
  return handleWebhookPost(request);
}
