'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { activateStyleVersion } from '@/actions/style';
import { Button } from '@/components/ui/button';

export function ActivateButton({ id, version }: { id: string; version: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-1">
      <Button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await activateStyleVersion({ id });
            if (result.ok) router.refresh();
            else setError(result.error.message);
          });
        }}
      >
        {pending ? 'Activating…' : `Activate version ${version}`}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
