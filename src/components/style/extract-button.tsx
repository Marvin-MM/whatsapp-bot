'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { requestStyleExtraction } from '@/actions/style';
import { Button } from '@/components/ui/button';

/** Starts an extraction; while the worker runs it, the page refreshes itself every few seconds until the new version (or the reason it failed) appears. */
export function ExtractButton({ running }: { running: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [running, router]);

  const start = () => {
    setError(null);
    startTransition(async () => {
      const result = await requestStyleExtraction({});
      if (result.ok) router.refresh();
      else setError(result.error.message);
    });
  };

  return (
    <div className="space-y-1">
      <Button type="button" onClick={start} disabled={pending || running}>
        {running ? 'Extracting…' : 'Extract new version'}
      </Button>
      {error ? (
        <p role="alert" className="max-w-sm text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
