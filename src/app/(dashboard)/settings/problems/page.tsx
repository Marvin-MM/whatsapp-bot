import type { Metadata } from 'next';
import Link from 'next/link';
import { DeliveryStatus } from '@/components/conversations/delivery-status';
import { metaCodeSuffix } from '@/components/conversations/message-bubble';
import { FailedJobRow } from '@/components/settings/failed-job-row';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatFullTimestamp } from '@/lib/conversations/format';
import { getProblemMessages } from '@/lib/dashboard/send-health';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { listFailedJobs } from '@/lib/ops/failed-jobs';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Problems' };

export default async function ProblemsPage() {
  await requireOwnerPage();
  const timeZone = getEnv().OWNER_TIMEZONE;
  const db = getDb();
  const [problems, jobs] = await Promise.all([getProblemMessages(db), listFailedJobs({ db }).then((list) => ({ ok: true as const, list }), () => ({ ok: false as const, list: [] }))]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Messages that need attention</CardTitle>
          <CardDescription>Messages that failed, could not be confirmed, or are still waiting to be sent.</CardDescription>
        </CardHeader>
        <CardContent>
          {problems.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing. Every message you sent went through.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {problems.map((problem) => (
                <li key={problem.messageId} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex items-center gap-2">
                      <DeliveryStatus status={problem.status} />
                      <time dateTime={problem.at.toISOString()} className="text-xs text-muted-foreground">
                        {formatFullTimestamp(problem.at, timeZone)}
                      </time>
                    </p>
                    {problem.error ? (
                      <p className="text-xs text-muted-foreground">
                        {problem.error.message}
                        {metaCodeSuffix(problem.error.code)}
                      </p>
                    ) : problem.status === 'queued' ? (
                      <p className="text-xs text-muted-foreground">Waiting for the worker. If this stays here, check that the worker is running.</p>
                    ) : null}
                  </div>
                  <Link href={`/conversations/${problem.conversationId}`} className="shrink-0 text-sm underline underline-offset-4">
                    Open conversation
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Failed background jobs</CardTitle>
          <CardDescription>
            Work the worker gave up on after several tries (a draft, a summary, a download, an incoming event). Retry runs it again; Dismiss only clears it from this list. A send that may have reached a customer cannot be retried here:
            check your phone from the conversation instead. Kept for 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!jobs.ok ? (
            <p role="alert" className="text-sm text-destructive">
              The queue could not be read just now (is Redis running?). Try again in a moment.
            </p>
          ) : jobs.list.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing has failed.</p>
          ) : (
            <ul className="divide-y divide-border">
              {jobs.list.map((job) => (
                <FailedJobRow key={`${job.queue}/${job.id}`} job={job} failedLabel={job.failedAt ? formatFullTimestamp(job.failedAt, timeZone) : 'time unknown'} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
