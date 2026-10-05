'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { updateAutopilotSettings } from '@/actions/autopilot';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';

export interface AutopilotSettingsValues {
  delaySeconds: number;
  maxPerConversationPerHour: number;
  maxPerDay: number;
  maxConsecutive: number;
  allowedIntents: string[];
  disclosure: string;
}

interface Props {
  initial: AutopilotSettingsValues;
  /** The intents the owner may allow, with their labels (a complaint and a request for a person can never be allowed). */
  intents: ReadonlyArray<{ id: string; label: string }>;
  delayRange: { min: number; max: number };
  maxDisclosureChars: number;
}

function NumberField({ id, label, hint, value, onChange, min, max }: { id: string; label: string; hint: string; value: string; onChange: (value: string) => void; min: number; max: number }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(event) => onChange(event.target.value)} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * Delay, limits, which kinds of message the autopilot may answer, and the line that tells customers a reply is automatic. The server validates
 * everything again (and refuses an empty disclosure); these fields only keep the owner inside the ranges it will accept.
 */
export function AutopilotSettingsForm({ initial, intents, delayRange, maxDisclosureChars }: Props) {
  const router = useRouter();
  const [delay, setDelay] = useState(String(initial.delaySeconds));
  const [perHour, setPerHour] = useState(String(initial.maxPerConversationPerHour));
  const [perDay, setPerDay] = useState(String(initial.maxPerDay));
  const [consecutive, setConsecutive] = useState(String(initial.maxConsecutive));
  const [allowed, setAllowed] = useState<string[]>(initial.allowedIntents);
  const [disclosure, setDisclosure] = useState(initial.disclosure);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (intent: string) => setAllowed((current) => (current.includes(intent) ? current.filter((item) => item !== intent) : [...current, intent]));

  const save = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await updateAutopilotSettings({
        delaySeconds: Number(delay),
        maxPerConversationPerHour: Number(perHour),
        maxPerDay: Number(perDay),
        maxConsecutive: Number(consecutive),
        allowedIntents: allowed,
        disclosure,
      });
      if (result.ok) {
        setMessage({ tone: 'ok', text: result.data.changed.length === 0 ? 'Nothing changed.' : 'Saved. It applies to the next reply.' });
        router.refresh();
      } else {
        const first = Object.values(result.error.fieldErrors ?? {}).flat()[0];
        setMessage({ tone: 'error', text: first ?? result.error.message });
      }
    });
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          id="ap-delay"
          label="Wait before sending (seconds)"
          hint={`The time you have to cancel. ${delayRange.min} to ${delayRange.max}.`}
          value={delay}
          onChange={setDelay}
          min={delayRange.min}
          max={delayRange.max}
        />
        <NumberField id="ap-hour" label="Most replies per customer per hour" hint="Beyond this, replies come to you." value={perHour} onChange={setPerHour} min={1} max={20} />
        <NumberField id="ap-day" label="Most automatic replies per day" hint="All customers together, your local day." value={perDay} onChange={setPerDay} min={1} max={200} />
        <NumberField id="ap-consec" label="Most in a row without you" hint="After this many, the next one waits for you. Your own reply resets it." value={consecutive} onChange={setConsecutive} min={1} max={20} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Kinds of message autopilot may answer</legend>
        <p className="text-xs text-muted-foreground">Anything else comes to you. Complaints and requests for a person are never answered automatically, so they are not offered here.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {intents.map((intent) => (
            <label key={intent.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={allowed.includes(intent.id)} onChange={() => toggle(intent.id)} />
              {intent.label}
            </label>
          ))}
        </div>
        {allowed.length === 0 ? <p className="text-xs text-warning">None selected: autopilot would send nothing.</p> : null}
      </fieldset>

      <div className="space-y-1">
        <Label htmlFor="ap-disclosure">Line added to automatic replies</Label>
        <Input id="ap-disclosure" value={disclosure} maxLength={maxDisclosureChars} onChange={(event) => setDisclosure(event.target.value)} />
        <p className="text-xs text-muted-foreground">
          Customers are told a reply is automatic: this line is added to the first automatic reply of every 24 hours. It cannot be empty. Quiet hours are set under General.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending}>
          Save
        </Button>
        {message ? (
          <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-success'}>
            {message.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
