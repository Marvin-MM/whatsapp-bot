'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveNotificationSettings, testTelegram } from '@/actions/notifications';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';

interface Props {
  notifyTelegram: boolean;
  quietHours: { start: string; end: string };
  /** The chat id with all but its last four characters hidden. */
  chatIdMasked: string;
}

export function TelegramSettings({ notifyTelegram, quietHours, chatIdMasked }: Props) {
  const router = useRouter();
  const [notify, setNotify] = useState(notifyTelegram);
  const [start, setStart] = useState(quietHours.start);
  const [end, setEnd] = useState(quietHours.end);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await saveNotificationSettings({ notifyTelegram: notify, quietHours: { start, end } });
      if (result.ok) {
        setMessage({ tone: 'ok', text: 'Saved.' });
        router.refresh();
      } else {
        const first = Object.values(result.error.fieldErrors ?? {}).flat()[0];
        setMessage({ tone: 'error', text: first ?? result.error.message });
      }
    });
  };

  const sendTest = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await testTelegram({});
      setMessage(result.ok ? { tone: 'ok', text: 'Test message sent. Check Telegram.' } : { tone: 'error', text: result.error.message });
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Alerts (a message that may not have been sent, a window about to close, a rejected WhatsApp token) are sent to your Telegram chat <code className="text-xs">{chatIdMasked}</code>. Alerts never contain message text.
      </p>
      <label className="flex items-center gap-3 text-sm">
        <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} className="h-4 w-4" />
        Send alerts to Telegram
      </label>
      <div className="grid max-w-sm grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="quiet-start">Quiet from</Label>
          <Input id="quiet-start" type="time" value={start} onChange={(event) => setStart(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="quiet-end">Quiet until</Label>
          <Input id="quiet-end" type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">During quiet hours (your local time) only critical alerts are sent. Everything still appears here.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={save} disabled={pending}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={sendTest} disabled={pending}>
          Send a test message
        </Button>
      </div>
      {message ? (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-success'}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
