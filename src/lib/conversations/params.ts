import { z } from 'zod';
import { LIST_FILTERS, type ListFilter } from './queries';

type RawParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const listSchema = z.object({
  filter: z.enum(LIST_FILTERS as readonly [ListFilter, ...ListFilter[]]).catch('all'),
  q: z.string().trim().max(100).catch(''),
  cursor: z.string().max(400).nullable().catch(null),
});

/** The conversation list's URL parameters. They come straight from the address bar, so nothing here can throw: bad input falls back. */
export function parseListParams(raw: RawParams): { filter: ListFilter; q: string; cursor: string | null } {
  return listSchema.parse({ filter: first(raw.filter) ?? 'all', q: first(raw.q) ?? '', cursor: first(raw.cursor) ?? null });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/** The thread page's "load earlier" cursor. */
export function parseThreadParams(raw: RawParams): { before: string | null } {
  const before = first(raw.before);
  return { before: before && before.length <= 400 ? before : null };
}

/** Builds a list URL that keeps only the parameters that differ from the defaults (clean, shareable links). */
export function listHref(params: { filter?: ListFilter; q?: string; cursor?: string | null }): string {
  const search = new URLSearchParams();
  if (params.filter && params.filter !== 'all') search.set('filter', params.filter);
  if (params.q) search.set('q', params.q);
  if (params.cursor) search.set('cursor', params.cursor);
  const query = search.toString();
  return query ? `/conversations?${query}` : '/conversations';
}
