'use client';

import { useState, useTransition } from 'react';
import { checkWhatsappToken } from '@/actions/whatsapp';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { TokenHealth as Health } from '@/lib/ops/token-health';

const TONE = { valid: 'success', invalid: 'danger', unreachable: 'warning' } as const;
const LABEL = { valid: 'Token works', invalid: 'Token rejected', unreachable: 'Could not check' } as const;

export function TokenHealth({ initial, checkedLabel }: { initial: Health | null; checkedLabel: string | null }) {
  const [health, setHealth] = useState(initial);
  const [label, setLabel] = useState(checkedLabel);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const check = () => {
    setError(null);
    startTransition(async () => {
      const result = await checkWhatsappToken({});
      if (result.ok) {
        setHealth(result.data);
        setLabel('just now');
      } else {
        setError(result.error.message);
      }
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {health ? <Badge variant={TONE[health.status]}>{LABEL[health.status]}</Badge> : <Badge>Not checked yet</Badge>}
        {health?.quality ? <Badge variant={health.quality === 'GREEN' ? 'success' : health.quality === 'RED' ? 'danger' : 'warning'}>Quality {health.quality.toLowerCase()}</Badge> : null}
        <Button type="button" size="sm" variant="outline" onClick={check} disabled={pending}>
          {pending ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      {health ? (
        <p className="text-sm text-muted-foreground">
          {health.detail} {label ? `Checked ${label}.` : ''}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">The token is checked every morning. Press “Check now” to check it immediately.</p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
