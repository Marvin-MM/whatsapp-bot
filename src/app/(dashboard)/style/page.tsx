import { desc } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ActivateButton } from '@/components/style/activate-button';
import { ExtractButton } from '@/components/style/extract-button';
import { StyleDiff } from '@/components/style/style-diff';
import { StyleGuideView } from '@/components/style/style-guide-view';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MIN_STYLE_MESSAGES, countEligibleOwnerMessages } from '@/lib/ai/style';
import { isRunning, readStyleStatus } from '@/lib/ai/style-status';
import { formatFullTimestamp } from '@/lib/conversations/format';
import { getDb } from '@/lib/db';
import { styleGuides } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Style' };

export default async function StylePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwnerPage();
  const params = await searchParams;
  const db = getDb();
  const timeZone = getEnv().OWNER_TIMEZONE;
  const [guides, eligible, status] = await Promise.all([db.select().from(styleGuides).orderBy(desc(styleGuides.version)), countEligibleOwnerMessages(db), readStyleStatus()]);

  const active = guides.find((guide) => guide.isActive) ?? null;
  const requested = typeof params.v === 'string' ? Number(params.v) : NaN;
  const selected = guides.find((guide) => guide.version === requested) ?? active ?? guides[0] ?? null;
  const running = isRunning(status);
  const when = (date: Date | null) => (date ? formatFullTimestamp(date, timeZone) : '');

  return (
    <>
      <PageHeader title="Style" description="How the assistant writes like you." actions={<ExtractButton running={running} />} />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>What it learns from</CardTitle>
          <CardDescription>
            {eligible >= MIN_STYLE_MESSAGES
              ? `${eligible} of your own messages are available (your replies from the phone, imported chats and drafts you edited). Messages the assistant wrote and you sent unchanged are never used.`
              : `Only ${eligible} of your own messages are available; at least ${MIN_STYLE_MESSAGES} are needed. Import your past chats with “pnpm import:chats”, or let your replies from the phone accumulate.`}
          </CardDescription>
        </CardHeader>
        {status ? (
          <CardContent>
            <p role="status" className={status.state === 'failed' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
              {running ? 'Extraction is running. This page refreshes by itself.' : status.message}
            </p>
          </CardContent>
        ) : null}
      </Card>

      {selected === null ? (
        <EmptyState title="No style guide yet" description="Extract one once you have enough of your own messages. Until then drafts are plain and short, and autopilot stays off." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>Version {selected.version}</CardTitle>
                  {selected.isActive ? <Badge variant="success">Active</Badge> : <Badge>Not active</Badge>}
                </div>
                <CardDescription>
                  Extracted {when(selected.createdAt)} from {selected.sourceMessageCount} of your messages
                  {selected.activatedAt ? `; activated ${when(selected.activatedAt)}` : ''}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <StyleGuideView content={selected.content} />
                {selected.isActive ? null : <ActivateButton id={selected.id} version={selected.version} />}
              </CardContent>
            </Card>

            {active && !selected.isActive ? (
              <Card>
                <CardHeader>
                  <CardTitle>What changes from version {active.version}</CardTitle>
                  <CardDescription>Read this before activating.</CardDescription>
                </CardHeader>
                <CardContent>
                  <StyleDiff active={active.content} selected={selected.content} />
                </CardContent>
              </Card>
            ) : null}
          </div>

          <nav aria-label="Versions" className="space-y-2">
            <h2 className="text-sm font-semibold">Versions</h2>
            <ul className="space-y-1">
              {guides.map((guide) => (
                <li key={guide.id}>
                  <Link
                    href={`/style?v=${guide.version}`}
                    aria-current={guide.id === selected.id ? 'page' : undefined}
                    className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted ${guide.id === selected.id ? 'border-foreground' : 'border-border'}`}
                  >
                    <span>Version {guide.version}</span>
                    {guide.isActive ? <Badge variant="success">Active</Badge> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      )}
    </>
  );
}
