'use client';

import { Check, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setKillSwitch } from '@/actions/settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface GateCheckView {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
}

/**
 * The system-wide autopilot switch and the checks that guard it. Every check is listed with its numbers, passing or not, so the owner can see how
 * close autopilot is. Turning it on is possible only while every check passes (the server refuses otherwise, with the same numbers) and asks for one
 * confirmation; turning it off is one press and stops every countdown that is running.
 */
export function AutopilotSwitch({ paused, eligible, checks }: { paused: boolean; eligible: boolean; checks: GateCheckView[] }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const change = (nextPaused: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await setKillSwitch({ name: 'autopilot_paused', value: nextPaused });
      if (result.ok) {
        setConfirming(false);
        router.refresh();
      } else {
        setError(result.error.message);
        router.refresh();
      }
    });
  };

  const passed = checks.filter((check) => check.ok).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            Autopilot is {paused ? 'off' : 'on'}
            <Badge variant={paused ? 'neutral' : 'warning'}>{paused ? 'Every reply waits for you' : 'Some replies are sent without you'}</Badge>
          </p>
          <p className="text-sm text-muted-foreground">
            {paused
              ? 'Turning it on does not change any conversation: each one still has to be switched to autopilot separately.'
              : 'Only conversations you switched to autopilot are affected. Turning it off stops every countdown that is running.'}
          </p>
        </div>
        {paused ? (
          confirming ? (
            <div className="flex gap-2">
              <Button size="sm" disabled={pending || !eligible} onClick={() => change(false)}>
                Yes, turn it on
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
                Not now
              </Button>
            </div>
          ) : (
            <Button size="sm" disabled={pending || !eligible} onClick={() => setConfirming(true)}>
              Turn on
            </Button>
          )
        ) : (
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => change(true)}>
            Turn off now
          </Button>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="gate-heading" className="space-y-2">
        <h3 id="gate-heading" className="text-sm font-semibold">
          Checks before autopilot can be on: {passed} of {checks.length} pass
        </h3>
        <ul className="space-y-1.5">
          {checks.map((check) => (
            <li key={check.id} className="flex items-start gap-2 text-sm">
              {check.ok ? <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <X aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
              <span>
                <span className="sr-only">{check.ok ? 'Passes: ' : 'Fails: '}</span>
                <span className="font-medium">{check.title}.</span> <span className="text-muted-foreground">{check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        {eligible ? null : (
          <p className="text-xs text-muted-foreground">
            These are measured live, from your real approved drafts and the latest evaluation. Nothing here can be bypassed: if a check fails again later (an old evaluation, a changed model), autopilot stops sending
            and every reply comes back to you.
          </p>
        )}
      </section>
    </div>
  );
}
