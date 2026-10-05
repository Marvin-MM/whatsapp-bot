import 'server-only';
import { z } from 'zod';
import { raiseAlert } from '@/lib/alerts';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getProducerConnection } from '@/lib/queue/connection';
import { GRAPH_ORIGIN } from '@/lib/whatsapp/client';

/**
 * Is the WhatsApp access token still good, and is the number healthy? Checked daily and on demand from Settings. A System User
 * token does not expire by itself, but it is revoked when its permissions or the user are removed: finding out from a customer's
 * unanswered message is the failure this exists to prevent. The result lives in Redis (it is a status, not business data).
 */

const TTL_SECONDS = 3 * 24 * 60 * 60;
const TIMEOUT_MS = 10_000;

export const tokenHealthSchema = z.object({
  checkedAt: z.iso.datetime(),
  /** `valid`: Meta accepted the token. `invalid`: Meta rejected it (the owner must act). `unreachable`: we could not tell. */
  status: z.enum(['valid', 'invalid', 'unreachable']),
  detail: z.string(),
  /** GREEN / YELLOW / RED / UNKNOWN: Meta's quality rating for the number. */
  quality: z.string().nullable(),
  verifiedName: z.string().nullable(),
});
export type TokenHealth = z.infer<typeof tokenHealthSchema>;

const nodeSchema = z.looseObject({ quality_rating: z.string().optional(), verified_name: z.string().optional() });
const errorSchema = z.looseObject({ error: z.looseObject({ code: z.number().optional(), message: z.string().optional() }) });

const cacheKey = () => `${getEnv().BULLMQ_PREFIX}:token-health`;
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

export async function checkTokenHealth(now: Date = new Date()): Promise<TokenHealth> {
  const env = getEnv();
  const base = { checkedAt: now.toISOString(), quality: null, verifiedName: null } as const;
  let health: TokenHealth;
  try {
    const response = await globalThis.fetch(
      `${GRAPH_ORIGIN}/${env.META_GRAPH_VERSION}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}?fields=quality_rating,verified_name`,
      { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    const json: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const node = nodeSchema.safeParse(json);
      health = { ...base, status: 'valid', detail: 'Meta accepted the token.', quality: node.success ? (node.data.quality_rating ?? null) : null, verifiedName: node.success ? (node.data.verified_name ?? null) : null };
    } else {
      const parsed = errorSchema.safeParse(json);
      const code = parsed.success ? parsed.data.error.code : undefined;
      // 190 = token invalid/expired/revoked; 102 = session ended; 10 / 200-299 = permission problems. All mean "the token cannot do this".
      const rejected = response.status === 401 || code === 190 || code === 102 || code === 10 || (code !== undefined && code >= 200 && code <= 299);
      health = rejected
        ? { ...base, status: 'invalid', detail: `Meta rejected the token${code === undefined ? '' : ` (error ${code})`}. Create a new System User token and update WHATSAPP_ACCESS_TOKEN.` }
        : { ...base, status: 'unreachable', detail: `Meta answered HTTP ${response.status}${code === undefined ? '' : ` (error ${code})`}: the token could not be checked.` };
    }
  } catch (error) {
    health = { ...base, status: 'unreachable', detail: `Could not reach Meta (${error instanceof Error ? error.name : 'error'}): the token could not be checked.` };
  }

  try {
    await getProducerConnection().set(cacheKey(), JSON.stringify(health), 'EX', TTL_SECONDS);
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'could not store token health');
  }

  if (health.status === 'invalid') {
    await raiseAlert({ kind: 'whatsapp_token_invalid', severity: 'critical', dedupeKey: `whatsapp_token_invalid:${utcDay(now)}` });
  } else if (health.status === 'unreachable') {
    // An outage on Meta's side or ours is not the owner's emergency: one quiet warning per day.
    await raiseAlert({ kind: 'token_check_failed', severity: 'warning', dedupeKey: `token_check_failed:${utcDay(now)}` });
  }
  return health;
}

/** The last stored result, for Settings. Null when never checked (or Redis is down). */
export async function readTokenHealth(): Promise<TokenHealth | null> {
  try {
    const raw = await getProducerConnection().get(cacheKey());
    if (raw === null) return null;
    const parsed = tokenHealthSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
