'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { markSent, resend } from '@/actions/send';
import { Button } from '@/components/ui/button';

/**
 * A message whose delivery we could not confirm (a timeout, a connection that broke after the write, a worker that died). We
 * NEVER guess and never resend by ourselves: the owner looks at their phone and says what happened.
 */
export function UnknownMessageActions({ messageId, canResend }: { messageId: string; canResend: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: typeof markSent | typeof resend) => {
    setError(null);
    startTransition(async () => {
      const result = await action({ messageId });
      if (result.ok) router.refresh();
      else setError(result.error.message);
    });
  };

  return (
    <div className="max-w-[88%] space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs sm:max-w-[75%]">
      <p>
        We could not confirm this was sent. <strong>Check WhatsApp on your phone</strong> to see whether it is there.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(markSent)}>
          It arrived
        </Button>
        {canResend ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(resend)}>
            It did not arrive: send again
          </Button>
        ) : (
          <span className="self-center text-muted-foreground">To send it again, use the template picker.</span>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
