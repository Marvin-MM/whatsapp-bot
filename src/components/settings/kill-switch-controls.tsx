'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { setKillSwitch } from '@/actions/settings';
import { cn } from '@/lib/utils';

interface Props {
  aiPaused: boolean;
  sendingPaused: boolean;
  autopilotPaused: boolean;
}

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-destructive/50 bg-destructive' : 'border-border bg-muted',
      )}
    >
      <span aria-hidden="true" className={cn('inline-block h-5 w-5 rounded-full bg-background shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

/**
 * The kill switches. A switch that is ON means "paused": the dangerous direction is the highlighted one, and it takes effect on the
 * very next send (the worker re-checks the switch immediately before calling Meta). Autopilot is not a switch here: turning it on is gated by
 * checks that need their numbers on screen, so it lives on its own page.
 */
export function KillSwitchControls({ aiPaused, sendingPaused, autopilotPaused }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (name: 'ai_paused' | 'sending_paused', value: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await setKillSwitch({ name, value });
      if (result.ok) router.refresh();
      else setError(result.error.message);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Pause sending</p>
          <p className="text-sm text-muted-foreground">
            {sendingPaused ? 'Nothing can be sent: replies you write are refused, and anything already waiting is stopped.' : 'Replies you approve or write are sent.'}
          </p>
        </div>
        <Switch checked={sendingPaused} disabled={pending} label="Pause sending" onChange={(next) => toggle('sending_paused', next)} />
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Pause AI drafting</p>
          <p className="text-sm text-muted-foreground">
            {aiPaused ? 'No drafts, summaries or transcripts are generated. Your inbox keeps working.' : 'The assistant drafts replies and summaries.'}
          </p>
        </div>
        <Switch checked={aiPaused} disabled={pending} label="Pause AI drafting" onChange={(next) => toggle('ai_paused', next)} />
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium">Autopilot</p>
          <p className="text-sm text-muted-foreground">
            {autopilotPaused
              ? 'Off. Every reply waits for your approval. It can be turned on only after it has proven itself on your real replies.'
              : 'On: replies in the conversations you chose may be sent without your approval.'}
          </p>
        </div>
        <Link href="/settings/autopilot" className="inline-flex h-9 shrink-0 items-center rounded-md border border-input bg-card px-3 text-sm hover:bg-muted">
          {autopilotPaused ? 'See the checks' : 'Manage'}
        </Link>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
