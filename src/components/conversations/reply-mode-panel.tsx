'use client';

import { Bot } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setReplyMode } from '@/actions/autopilot';
import { Button } from '@/components/ui/button';

export interface ReplyModeStatus {
  paused: boolean;
  eligible: boolean;
  failed: Array<{ title: string; detail: string }>;
}

const PERIODS = [
  { id: 'forever', label: 'Until I turn it off', hours: null },
  { id: 'day', label: 'For 24 hours', hours: 24 },
  { id: 'week', label: 'For 7 days', hours: 24 * 7 },
  { id: 'month', label: 'For 30 days', hours: 24 * 30 },
] as const;

/**
 * How replies to THIS customer are sent: every one waits for the owner (approval, the default), or the autopilot may send some by itself. Autopilot is
 * offered only while the system-wide checks pass and it is switched on; otherwise the option is shown disabled with the failing numbers, so the
 * owner sees exactly what is missing. Switching back to approval is always possible.
 */
export function ReplyModePanel({ conversationId, mode, until, status, untilLabel }: { conversationId: string; mode: 'approval' | 'autopilot'; until: string | null; status: ReplyModeStatus; untilLabel: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<'approval' | 'autopilot'>(mode);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['id']>('forever');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const canEnable = status.eligible && !status.paused;

  const save = () => {
    setError(null);
    const hours = PERIODS.find((item) => item.id === period)?.hours ?? null;
    startTransition(async () => {
      const result = await setReplyMode({ conversationId, mode: choice, until: choice === 'autopilot' && hours !== null ? new Date(Date.now() + hours * 3600_000).toISOString() : null });
      if (result.ok) {
        setOpen(false);
        router.refresh();
      } else setError(result.error.message);
    });
  };

  return (
    <section aria-label="How replies are sent" className="mb-3 rounded-lg border border-border bg-card text-sm">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <p className="flex min-w-0 items-center gap-2">
          <Bot aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <strong>Replies:</strong>{' '}
            {mode === 'autopilot' ? `autopilot may send some by itself${until && untilLabel ? ` (until ${untilLabel})` : ''}` : 'you approve each one'}
          </span>
        </p>
        <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? 'Close' : 'Change'}
        </Button>
      </div>

      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <fieldset className="space-y-2">
            <legend className="sr-only">Reply mode</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name={`mode-${conversationId}`} checked={choice === 'approval'} onChange={() => setChoice('approval')} className="mt-1" />
              <span>
                <span className="font-medium">Approval</span>
                <span className="block text-muted-foreground">Every reply waits for you in Approvals. This is the default.</span>
              </span>
            </label>
            <label className={`flex items-start gap-2 ${canEnable ? '' : 'opacity-70'}`}>
              <input type="radio" name={`mode-${conversationId}`} checked={choice === 'autopilot'} disabled={!canEnable && mode !== 'autopilot'} onChange={() => setChoice('autopilot')} className="mt-1" />
              <span>
                <span className="font-medium">Autopilot</span>
                <span className="block text-muted-foreground">
                  Simple, well-supported replies go out by themselves after a short delay you can cancel; anything unusual still comes to you. Customers are told the reply is automatic.
                </span>
              </span>
            </label>
          </fieldset>

          {choice === 'autopilot' && canEnable ? (
            <label className="block">
              <span className="mb-1 block font-medium">How long</span>
              <select value={period} onChange={(event) => setPeriod(event.target.value as typeof period)} className="h-9 w-full rounded-md border border-border bg-background px-2 sm:w-64">
                {PERIODS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {!canEnable ? (
            <div role="note" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-muted-foreground">
              <p className="font-medium text-foreground">{status.paused ? 'Autopilot is off.' : 'Autopilot cannot be used yet.'}</p>
              {status.paused ? <p>Turn it on in Settings once the checks pass.</p> : null}
              {status.failed.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {status.failed.slice(0, 4).map((check) => (
                    <li key={check.title}>
                      {check.title}: {check.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-1">
                <Link href="/settings/autopilot" className="underline underline-offset-4">
                  See all the checks
                </Link>
              </p>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={pending || choice === mode}>
              Save
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
