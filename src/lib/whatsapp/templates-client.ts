import 'server-only';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getProducerConnection } from '@/lib/queue/connection';
import { GRAPH_ORIGIN } from './client';
import { type TemplateSummary, rawTemplateSchema, summariseTemplate } from './templates';

/**
 * Reads the account's message templates from Meta and caches them in Redis. Two readers with different rules:
 *
 *   `loadTemplates`        (the picker)   refreshes when the copy is older than 5 minutes; if Meta is unreachable it falls back to
 *                                         the stale copy and says so, rather than leaving the owner with no templates at all.
 *   `readCachedTemplates`  (the send)     NEVER touches the network: a server action must not hold a database transaction open
 *                                         across an HTTP call. The picker has just warmed the cache (it lives for an hour).
 */

const FRESH_MS = 5 * 60 * 1000;
const CACHE_TTL_SECONDS = 60 * 60;
const MAX_PAGES = 5;
const FETCH_TIMEOUT_MS = 10_000;

export class TemplatesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplatesUnavailableError';
  }
}

export interface TemplateList {
  templates: TemplateSummary[];
  fetchedAt: Date;
  /** True when Meta could not be reached and this is an older copy. */
  stale: boolean;
}

const cacheSchema = z.object({
  fetchedAt: z.iso.datetime(),
  templates: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      language: z.string(),
      category: z.string(),
      status: z.string(),
      body: z.string(),
      paramFormat: z.enum(['positional', 'named']),
      params: z.array(z.string()),
      supported: z.boolean(),
      unsupportedReason: z.string().nullable(),
    }),
  ),
});

const pageSchema = z.looseObject({
  data: z.array(z.unknown()),
  paging: z.looseObject({ next: z.string().optional() }).optional(),
});

const cacheKey = () => `${getEnv().BULLMQ_PREFIX}:templates:v1`;

/** Only ever follow a `next` link that stays on Graph: the request carries our access token. */
function isGraphUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.origin === GRAPH_ORIGIN;
  } catch {
    return false;
  }
}

export async function fetchTemplates(): Promise<TemplateSummary[]> {
  const env = getEnv();
  const first = new URL(`${GRAPH_ORIGIN}/${env.META_GRAPH_VERSION}/${encodeURIComponent(env.WHATSAPP_WABA_ID)}/message_templates`);
  first.searchParams.set('fields', 'name,language,status,category,parameter_format,components');
  first.searchParams.set('limit', '100');

  const summaries: TemplateSummary[] = [];
  let next: string | undefined = first.toString();
  for (let page = 0; next !== undefined && page < MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await globalThis.fetch(next, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
      throw new TemplatesUnavailableError(`Could not reach Meta (${error instanceof Error ? error.name : 'network error'}).`);
    }
    if (!response.ok) throw new TemplatesUnavailableError(`Meta answered HTTP ${response.status} when listing templates.`);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new TemplatesUnavailableError('Meta sent a template list we could not read.');
    }
    const parsed = pageSchema.safeParse(json);
    if (!parsed.success) throw new TemplatesUnavailableError('Meta sent a template list in a shape we did not expect.');

    for (const item of parsed.data.data) {
      const raw = rawTemplateSchema.safeParse(item);
      if (raw.success) summaries.push(summariseTemplate(raw.data));
      else logger.warn('skipping a template Meta sent in an unexpected shape');
    }
    const link = parsed.data.paging?.next;
    next = link !== undefined && isGraphUrl(link) ? link : undefined;
  }
  // Supported first, then by name: the picker's order.
  return summaries.sort((a, b) => Number(b.supported) - Number(a.supported) || a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}

async function readCache(): Promise<TemplateList | null> {
  try {
    const raw = await getProducerConnection().get(cacheKey());
    if (raw === null) return null;
    const parsed = cacheSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return { templates: parsed.data.templates, fetchedAt: new Date(parsed.data.fetchedAt), stale: false };
  } catch {
    return null;
  }
}

async function writeCache(templates: TemplateSummary[], fetchedAt: Date): Promise<void> {
  try {
    await getProducerConnection().set(cacheKey(), JSON.stringify({ fetchedAt: fetchedAt.toISOString(), templates }), 'EX', CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'could not cache templates');
  }
}

/** For the picker: fresh when possible, stale rather than nothing. Throws `TemplatesUnavailableError` only when there is no copy at all. */
export async function loadTemplates(options: { force?: boolean; now?: Date } = {}): Promise<TemplateList> {
  const now = options.now ?? new Date();
  const cached = await readCache();
  if (cached && !options.force && now.getTime() - cached.fetchedAt.getTime() < FRESH_MS) return cached;
  try {
    const templates = await fetchTemplates();
    await writeCache(templates, now);
    return { templates, fetchedAt: now, stale: false };
  } catch (error) {
    if (cached) return { ...cached, stale: true };
    throw error;
  }
}

/** For the send: whatever the picker last loaded, never the network. */
export async function readCachedTemplates(): Promise<TemplateList | null> {
  return readCache();
}
