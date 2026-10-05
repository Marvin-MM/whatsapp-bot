'use client';

import { Bot } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cancelAutopilotSend, sendAutopilotNow } from '@/actions/autopilot';
import { useNow } from '@/components/conversations/use-now';
import { Button } from '@/components/ui/button';
import { ROUTE_REASON_TEXT, type RouteReason } from '@/lib/autopilot/policy';

/** What the autopilot did NOT do, in words: shown on a draft it looked at and handed to the owner. Plain text; nothing to press. */
export function AutopilotWhyNot({ reasons }: { reasons: readonly string[] }) {
  const words = reasons.map((reason) => (reason in ROUTE_REASON_TEXT ? ROUTE_REASON_TEXT[reason as RouteReason] : reason.replaceAll('_', ' ')));
  return (
    <p className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
      <Bot aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span>Autopilot did not send this: {words.join('; ')}.</span>
    </p>
  );
}

/**
 * A draft the autopilot is about to send: when, and the two controls. Cancel puts it back in the queue for the owner; Send now skips the rest of
 * the wait (the final checks still run). The page re-reads after each press, so the notice disappears with the countdown.
 */
export function AutopilotCountdown({ draftId, sendAt, serverNow }: { draftId: string; sendAt: Date; serverNow: Date }) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const seconds = Math.max(0, Math.round((sendAt.getTime() - now.getTime()) / 1000));

  const run = (action: typeof cancelAutopilotSend) => {
    setError(null);
    startTransition(async () => {
      const result = await action({ draftId });
      if (result.ok) router.refresh();
      else {
        setError(result.error.message);
        router.refresh();
      }
    });
  };

  return (
    <div role="status" className="space-y-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm">
      <p className="flex items-start gap-2">
        <Bot aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <strong>Autopilot will send this {seconds > 0 ? `in ${seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`}` : 'now'}.</strong> An independent check found nothing wrong. Cancel to read it
          yourself.
        </span>
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(cancelAutopilotSend)}>
          Cancel
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(sendAutopilotNow)}>
          Send now
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
