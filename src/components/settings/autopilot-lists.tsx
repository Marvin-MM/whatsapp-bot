'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { cancelAutopilotSend, sendAutopilotNow, setReplyMode } from '@/actions/autopilot';
import { useNow } from '@/components/conversations/use-now';
import { Button } from '@/components/ui/button';

/** One automatic reply that is counting down: who it is for, when it goes, and the two controls. The conversation link is how to read it first. */
export function ScheduledSendRow({ draftId, conversationId, name, sendAtIso, serverNowIso }: { draftId: string; conversationId: string; name: string; sendAtIso: string | null; serverNowIso: string }) {
  const router = useRouter();
  const now = useNow(new Date(serverNowIso));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const seconds = sendAtIso ? Math.max(0, Math.round((new Date(sendAtIso).getTime() - now.getTime()) / 1000)) : null;

  const run = (action: typeof cancelAutopilotSend) => {
    setError(null);
    startTransition(async () => {
      const result = await action({ draftId });
      if (!result.ok) setError(result.error.message);
      router.refresh();
    });
  };

  return (
    <li className="space-y-1 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm">
          <Link href={`/conversations/${conversationId}`} className="font-medium underline-offset-4 hover:underline">
            {name}
          </Link>{' '}
          <span className="text-muted-foreground">{seconds === null ? 'is waiting to be sent' : seconds === 0 ? 'is being sent' : `goes in ${seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`}`}</span>
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(cancelAutopilotSend)}>
            Cancel
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(sendAutopilotNow)}>
            Send now
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** One conversation that is on autopilot, with the way off. Going back to approval is always allowed and stops a countdown running for it. */
export function AutopilotConversationRow({ conversationId, name, untilLabel }: { conversationId: string; name: string; untilLabel: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const takeOff = () => {
    setError(null);
    startTransition(async () => {
      const result = await setReplyMode({ conversationId, mode: 'approval', until: null });
      if (!result.ok) setError(result.error.message);
      router.refresh();
    });
  };

  return (
    <li className="space-y-1 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm">
          <Link href={`/conversations/${conversationId}`} className="font-medium underline-offset-4 hover:underline">
            {name}
          </Link>{' '}
          <span className="text-muted-foreground">{untilLabel ? `until ${untilLabel}` : 'until you turn it off'}</span>
        </p>
        <Button size="sm" variant="outline" disabled={pending} onClick={takeOff}>
          Back to approval
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
