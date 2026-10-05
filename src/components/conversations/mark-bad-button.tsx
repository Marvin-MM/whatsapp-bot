'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { markAutopilotBad } from '@/actions/autopilot';

/**
 * "Mark bad" under an automatic reply: flags it for review and takes the conversation off autopilot. Two presses (the second says what will happen) so a
 * thumb on a phone cannot do it by accident; once marked it is a plain label.
 */
export function MarkBadButton({ messageId, markedBad }: { messageId: string; markedBad: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (markedBad) return <span className="px-1 text-xs text-destructive">Marked bad: autopilot was switched off for this customer</span>;

  const confirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await markAutopilotBad({ messageId });
      if (result.ok) router.refresh();
      else {
        setError(result.error.message);
        setConfirming(false);
      }
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
      {confirming ? (
        <>
          <span className="text-muted-foreground">Mark this reply bad and switch autopilot off for this customer?</span>
          <button type="button" onClick={confirm} disabled={pending} className="rounded border border-destructive/50 px-2 py-0.5 text-destructive hover:bg-destructive/10 disabled:opacity-50">
            Yes, mark bad
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={pending} className="underline underline-offset-4">
            No
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="underline underline-offset-4 text-muted-foreground hover:text-foreground">
          Mark bad
        </button>
      )}
      {error ? (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
