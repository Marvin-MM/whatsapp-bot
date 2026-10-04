'use client';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** Inline error state: a failed page explains itself and can retry, instead of a blank screen. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card role="alert" className="flex flex-col items-start gap-3 border-destructive/40 p-6">
      <h2 className="text-base font-semibold text-destructive">This page could not be loaded</h2>
      <p className="text-sm text-muted-foreground">
        Your data is safe; nothing was changed. Try again, and if it keeps failing check the worker and database.
      </p>
      {error.digest ? <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </Card>
  );
}
