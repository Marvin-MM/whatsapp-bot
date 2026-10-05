'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { requestDraft } from '@/actions/drafts';
import { Button } from '@/components/ui/button';

/**
 * Above the reply box on a conversation: a link to the draft that is waiting, or the way to ask for one. Without it a customer whose
 * draft was rejected (or who wrote while AI drafting was paused) would have no route back to a draft except typing everything by hand.
 */
export function DraftPrompt({ conversationId, openDraftId, canRequest, aiPaused }: { conversationId: string; openDraftId: string | null; canRequest: boolean; aiPaused: boolean }) {
  const [pending, startTransition] = useTransition();
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (openDraftId) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm">
        <Sparkles aria-hidden="true" className="h-4 w-4 shrink-0 text-info" />
        <span>A drafted reply is waiting for your decision.</span>
        <Link href={`/approvals?d=${openDraftId}`} className="font-medium underline underline-offset-4">
          Review the draft
        </Link>
      </p>
    );
  }
  if (!canRequest) return null;
  if (aiPaused) return <p className="text-sm text-muted-foreground">AI drafting is paused (see Settings), so no draft will be written.</p>;

  return (
    <div className="space-y-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending || asked}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await requestDraft({ conversationId });
            if (result.ok) setAsked(true);
            else setError(result.error.message);
          });
        }}
      >
        <Sparkles aria-hidden="true" className="h-4 w-4" />
        {asked ? 'Writing a draft…' : 'Draft a reply'}
      </Button>
      {asked ? <p role="status" className="text-xs text-muted-foreground">The draft appears here in a few seconds, and in Approvals.</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
