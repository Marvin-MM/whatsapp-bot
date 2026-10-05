'use client';

import { RotateCcw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { dismissJob, retryJob } from '@/actions/jobs';
import { Button } from '@/components/ui/button';
import type { FailedJob } from '@/lib/ops/failed-jobs';

/** One failed job: what it was, why it failed, and Retry (where that is safe: otherwise the reason it is not) or Dismiss. */
export function FailedJobRow({ job, failedLabel }: { job: Pick<FailedJob, 'queue' | 'id' | 'name' | 'error' | 'attemptsMade' | 'subject' | 'retry'>; failedLabel: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // The job is already gone (retried or removed elsewhere): say so and leave the row in place, because refreshing would remove the row
  // together with the only explanation of what happened.
  const [gone, setGone] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = (action: typeof retryJob) => {
    setError(null);
    startTransition(async () => {
      const result = await action({ queue: job.queue, jobId: job.id });
      if (result.ok) router.refresh();
      else {
        setError(result.error.message);
        if (result.error.code === 'refused' && (result.error.reason === 'not_found' || result.error.reason === 'not_failed')) setGone(true);
        // A job whose state changed under the page keeps its row (and this message) while the new reason is fetched.
        else if (result.error.code === 'refused') router.refresh();
      }
    });
  };

  return (
    <li className="space-y-1.5 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{job.queue}</code>
        <span className="text-xs text-muted-foreground">
          {failedLabel} · {job.attemptsMade} attempt{job.attemptsMade === 1 ? '' : 's'}
        </span>
      </div>
      <p className="break-words text-destructive">{job.error}</p>
      {job.subject.length > 0 ? (
        <p className="break-all text-xs text-muted-foreground">
          {job.subject.map((part) => `${part.label}: ${part.value}`).join(' · ')}
        </p>
      ) : null}
      {!job.retry.allowed ? <p className="text-xs text-muted-foreground">{job.retry.reason}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => run(retryJob)} disabled={pending || gone || !job.retry.allowed}>
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          Retry
        </Button>
        <Button size="sm" variant="ghost" onClick={() => run(dismissJob)} disabled={pending || gone}>
          <Trash2 aria-hidden="true" className="h-4 w-4" />
          Dismiss
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}
