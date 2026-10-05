import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatFullTimestamp } from '@/lib/conversations/format';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { AUDIT_ACTORS, type AuditFilters, listAudit, listAuditFilterOptions, parseAuditParams } from '@/lib/ops/audit-view';
import { auditEntityHref, describeMetadata } from '@/lib/ops/audit-present';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Audit log' };

function hrefFor(filters: AuditFilters, cursor: string | null): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
  if (cursor) search.set('cursor', cursor);
  const query = search.toString();
  return query ? `/settings/audit?${query}` : '/settings/audit';
}

const SELECT = 'mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm';

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwnerPage();
  const { filters, cursor } = parseAuditParams(await searchParams);
  const timeZone = getEnv().OWNER_TIMEZONE;
  const db = getDb();
  const [page, options] = await Promise.all([listAudit(db, filters, cursor, timeZone), listAuditFilterOptions(db)]);
  const filtered = Object.values(filters).some(Boolean);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>Every change made through the dashboard, newest first: who (you, the assistant, or autopilot), what, and to which record. It records ids and kinds, never what a message said. Entries cannot be edited or deleted.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form method="get" action="/settings/audit" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Filter the audit log">
          <label className="block text-sm font-medium" htmlFor="audit-action">
            Action
            <select id="audit-action" name="action" defaultValue={filters.action ?? ''} className={SELECT}>
              <option value="">Any</option>
              {options.actions.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium" htmlFor="audit-entity">
            Record
            <select id="audit-entity" name="entity" defaultValue={filters.entity ?? ''} className={SELECT}>
              <option value="">Any</option>
              {options.entities.map((entity) => (
                <option key={entity} value={entity}>
                  {entity}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium" htmlFor="audit-actor">
            Who
            <select id="audit-actor" name="actor" defaultValue={filters.actor ?? ''} className={SELECT}>
              <option value="">Anyone</option>
              {AUDIT_ACTORS.map((actor) => (
                <option key={actor} value={actor}>
                  {actor}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium" htmlFor="audit-from">
            From
            <input id="audit-from" type="date" name="from" defaultValue={filters.from ?? ''} className={SELECT} />
          </label>
          <label className="block text-sm font-medium" htmlFor="audit-to">
            To (whole day)
            <input id="audit-to" type="date" name="to" defaultValue={filters.to ?? ''} className={SELECT} />
          </label>
          <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-5">
            <Button type="submit" size="sm">
              Filter
            </Button>
            {filtered ? (
              <Link href="/settings/audit" className="text-sm underline underline-offset-4">
                Clear the filters
              </Link>
            ) : null}
          </div>
        </form>

        {page.rows.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">{filtered ? 'No entries match these filters.' : 'Nothing has been recorded yet.'}</p>
        ) : (
          <ol aria-label="Audit entries" className="divide-y divide-border rounded-md border border-border">
            {page.rows.map((row) => {
              const href = auditEntityHref(row.entityType, row.entityId);
              const details = describeMetadata(row.metadata);
              return (
                <li key={row.id} className="space-y-1 px-3 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">{row.action}</code>
                    <Badge variant={row.actor === 'owner' ? 'neutral' : 'info'}>{row.actor}</Badge>
                    <time dateTime={row.at.toISOString()} className="text-xs text-muted-foreground">
                      {formatFullTimestamp(row.at, timeZone)}
                    </time>
                  </div>
                  <p className="break-all text-xs text-muted-foreground">
                    {row.entityType}{' '}
                    {href ? (
                      <Link href={href} className="underline underline-offset-4">
                        {row.entityId}
                      </Link>
                    ) : (
                      row.entityId
                    )}
                  </p>
                  {details.length > 0 ? <p className="break-words text-xs text-muted-foreground">{details.join(' · ')}</p> : null}
                </li>
              );
            })}
          </ol>
        )}

        <div className="flex items-center justify-between text-sm">
          {cursor ? (
            <Link href={hrefFor(filters, null)} className="underline underline-offset-4">
              Back to the newest
            </Link>
          ) : (
            <span />
          )}
          {page.nextCursor ? (
            <Link href={hrefFor(filters, page.nextCursor)} className="inline-flex h-9 items-center rounded-full border border-border bg-card px-4 hover:bg-muted">
              Older entries
            </Link>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
