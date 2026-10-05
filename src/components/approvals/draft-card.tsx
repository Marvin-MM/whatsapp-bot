'use client';

import { Pencil, RefreshCw, RotateCcw, SendHorizontal, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react';
import { approveDraft, regenerateDraft, rejectDraft } from '@/actions/drafts';
import type { ActionError } from '@/lib/actions/owner-action-core';
import { newIdempotencyKey } from '@/components/send/new-key';
import { useNow } from '@/components/conversations/use-now';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { isWindowOpen } from '@/lib/conversations/window';
import { describeEditRate, findPlaceholders, intentLabel, intentTone, isEdited, riskFlagLabel } from '@/lib/drafts/present';
import type { DraftDetail } from '@/lib/drafts/queries';
import { MAX_TEXT_LENGTH } from '@/lib/send/precheck';
import { AutopilotCountdown, AutopilotWhyNot } from './autopilot-notice';
import { showFlash } from './flash';

export interface DraftCardProps {
  draft: DraftDetail;
  serverNow: Date;
  sendingPaused: boolean;
  aiPaused: boolean;
  canReceive: boolean;
  /** The neighbours in the queue: where `j`/`k` go, and where the owner lands after deciding. */
  prevId: string | null;
  nextId: string | null;
}

const TERMINAL_TEXT: Record<string, string> = {
  approved: 'You approved this draft and it was sent as written.',
  edited: 'You edited this draft and it was sent.',
  rejected: 'You rejected this draft.',
  superseded: 'This draft was replaced: the customer wrote again, or a new draft was requested. A new one appears here as soon as it is ready.',
  cancelled: 'This draft was cancelled.',
};

/** After a decision the next card mounts and takes focus, so the keyboard flow (a, a, a) continues without reaching for the mouse. */
let focusNextCard = false;

const hrefFor = (id: string | null) => (id ? `/approvals?d=${id}` : '/approvals');

/**
 * One drafted reply and the owner's decision about it. The server decides everything that matters (the send pre-check runs again in a
 * transaction): this component only mirrors the rules so the owner sees WHY the button is off before pressing it, and keeps their
 * edit if the server refuses.
 *
 * One idempotency key per card (the page keys this component by draft id): a double click or a slow network is one message, and a
 * retry after a refusal safely reuses it because a refusal writes nothing.
 */
export function DraftCard({ draft, serverNow, sendingPaused, aiPaused, canReceive, prevId, nextId }: DraftCardProps) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [text, setText] = useState(draft.content);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [pending, startTransition] = useTransition();
  const key = useRef(newIdempotencyKey());
  const box = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLElement>(null);

  const open = draft.status === 'pending' || draft.status === 'scheduled';
  const failed = draft.status === 'failed';
  const edited = isEdited(draft.originalContent, text);
  const placeholders = findPlaceholders(text);
  const windowOpen = isWindowOpen(draft.windowExpiresAt, now);
  const tooLong = text.length > MAX_TEXT_LENGTH;

  // The first thing standing between this draft and "sent", in the words the owner needs. Null means the server will accept it.
  const blocker = !open
    ? null
    : sendingPaused
      ? 'Sending is paused, so nothing can be sent.'
      : !canReceive
        ? 'This contact has no phone number yet, so there is nobody to send to.'
        : !windowOpen
          ? 'It has been more than 24 hours since the customer wrote: WhatsApp only allows an approved template now. Open the conversation to send one.'
          : text.trim() === ''
            ? draft.noReplyNeeded
              ? 'The assistant thinks this message needs no reply. Write one if you disagree, or dismiss it.'
              : 'The reply is empty.'
            : placeholders.length > 0
              ? `Fill in ${placeholders.length === 1 ? 'the [[placeholder]]' : `the ${placeholders.length} [[placeholders]]`} with the real answer before sending.`
              : tooLong
                ? `The reply is ${text.length} characters; WhatsApp allows ${MAX_TEXT_LENGTH}.`
                : null;
  const ready = open && blocker === null && !pending;

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight + 2, 420)}px`;
  }, [text]);

  useEffect(() => {
    if (focusNextCard) {
      focusNextCard = false;
      card.current?.focus();
    }
  }, []);

  const finish = () => {
    focusNextCard = true;
    router.replace(hrefFor(nextId ?? prevId));
  };

  const refused = (failure: ActionError) => {
    setError(failure.message);
    // The draft changed under us (another tab, a new message): re-read the truth instead of leaving a card that no longer applies.
    if (failure.code === 'refused' && (failure.reason === 'draft_not_open' || failure.reason === 'not_found')) router.refresh();
  };

  const approve = (overrideStale: boolean) => {
    if (!ready || (draft.stale && !overrideStale)) return;
    setError(null);
    startTransition(async () => {
      const result = await approveDraft({ draftId: draft.id, text, overrideStale, idempotencyKey: key.current });
      if (!result.ok) return refused(result.error);
      showFlash({ tone: 'success', text: `Approved: sending to ${draft.name}.` });
      finish();
    });
  };

  const reject = () => {
    if (draft.status !== 'pending' || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await rejectDraft({ draftId: draft.id });
      if (!result.ok) return refused(result.error);
      showFlash({ tone: 'neutral', text: `Draft rejected. ${draft.name} is still waiting for a reply.` });
      finish();
    });
  };

  const regenerate = () => {
    if ((draft.status !== 'pending' && !failed) || pending || asked) return;
    setError(null);
    startTransition(async () => {
      const result = await regenerateDraft({ draftId: draft.id });
      if (!result.ok) return refused(result.error);
      setAsked(true);
      showFlash({ tone: 'neutral', text: `Writing a new draft for ${draft.name}…` });
    });
  };

  const edit = () => {
    const element = box.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  };

  const selectPlaceholder = (start: number, end: number) => {
    const element = box.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(start, end);
  };

  // Re-registered on every render (no dependency list) so the handler always sees the current state: it is one cheap listener.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      switch (event.key) {
        case 'a':
          if (ready && !draft.stale) {
            event.preventDefault();
            approve(false);
          }
          break;
        case 'e':
          if (open) {
            event.preventDefault();
            edit();
          }
          break;
        case 'r':
          if (draft.status === 'pending' && !pending) {
            event.preventDefault();
            reject();
          }
          break;
        case 'g':
          if ((draft.status === 'pending' || failed) && !pending && !asked && !aiPaused) {
            event.preventDefault();
            regenerate();
          }
          break;
        case 'j':
          if (nextId) router.push(hrefFor(nextId));
          break;
        case 'k':
          if (prevId) router.push(hrefFor(prevId));
          break;
        default:
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const tone = intentTone(draft.intent);

  return (
    <section ref={card} tabIndex={-1} aria-label={`Drafted reply for ${draft.name}`} className="space-y-4 rounded-lg border border-border bg-card p-4 outline-none">
      <div className="flex flex-wrap items-center gap-1.5">
        {open || failed ? (
          <Link href={`/conversations/${draft.conversationId}`} className="order-last ml-auto text-sm underline underline-offset-4">
            Reply by hand
          </Link>
        ) : null}
        <Badge variant={tone}>{intentLabel(draft.intent)}</Badge>
        {draft.noReplyNeeded ? <Badge>Probably needs no reply</Badge> : null}
        {draft.status === 'scheduled' ? <Badge variant="info">Scheduled to send</Badge> : null}
        {draft.riskFlags.map((flag) => (
          <Badge key={flag} variant="warning" title={riskFlagLabel(flag)}>
            <TriangleAlert aria-hidden="true" className="h-3 w-3" />
            {riskFlagLabel(flag)}
          </Badge>
        ))}
      </div>

      {draft.status === 'scheduled' && draft.scheduledSendAt ? <AutopilotCountdown draftId={draft.id} sendAt={draft.scheduledSendAt} serverNow={serverNow} /> : null}
      {draft.status === 'pending' && draft.autopilotReasons && draft.autopilotReasons.length > 0 ? <AutopilotWhyNot reasons={draft.autopilotReasons} /> : null}

      {open && draft.stale ? (
        <Notice tone="warning" title="The customer wrote again after this draft was made">
          It may no longer answer them. Read their latest message above. Regenerate for a fresh draft, or send this one anyway.
        </Notice>
      ) : null}

      {failed ? (
        <Notice tone="danger" title="The assistant could not write this draft">
          {asked ? 'A new attempt is running: it appears here when it is ready.' : 'Nothing was sent. Try again, or write the reply yourself in the conversation.'}
        </Notice>
      ) : null}

      {!open && !failed ? <Notice title={TERMINAL_TEXT[draft.status] ?? `This draft is ${draft.status}.`}>{null}</Notice> : null}

      {draft.missingFacts.length > 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="font-medium">The assistant did not know:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {draft.missingFacts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!failed ? (
        <div>
          <label htmlFor={`draft-${draft.id}`} className="mb-1 block text-sm font-medium">
            {open ? 'Reply to send' : 'Reply as sent'}
          </label>
          <textarea
            id={`draft-${draft.id}`}
            ref={box}
            value={text}
            readOnly={!open}
            rows={4}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.blur();
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !draft.stale) {
                event.preventDefault();
                approve(false);
              }
            }}
            aria-describedby={`draft-help-${draft.id}`}
            className="min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-base read-only:bg-muted md:text-sm"
          />
          <div id={`draft-help-${draft.id}`} className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{open ? 'Ctrl or ⌘ + Enter sends · Esc leaves the box' : null}</span>
            <span className={tooLong ? 'text-destructive' : ''}>
              {text.length}/{MAX_TEXT_LENGTH}
            </span>
          </div>
        </div>
      ) : null}

      {open && placeholders.length > 0 ? (
        <div aria-label="Placeholders to fill in" className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">Fill in:</span>
          {placeholders.map((match) => (
            <button
              key={`${match.start}-${match.text}`}
              type="button"
              onClick={() => selectPlaceholder(match.start, match.end)}
              className="rounded-md border border-warning/50 bg-warning/10 px-2 py-0.5 font-mono text-xs hover:bg-warning/20"
            >
              {match.text}
            </button>
          ))}
        </div>
      ) : null}

      {open || failed ? (
        <div className="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 -mx-4 -mb-4 space-y-2 rounded-b-lg border-t border-border bg-card px-4 py-2.5 md:bottom-0">
          {/* Next to the buttons it explains, so a greyed-out Approve is never a mystery, however far down the page the owner is. */}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : open && blocker ? (
            <p role="status" className="text-sm text-muted-foreground">
              {blocker}
              {!windowOpen && canReceive ? (
                <>
                  {' '}
                  <Link href={`/conversations/${draft.conversationId}`} className="underline underline-offset-4">
                    Open conversation
                  </Link>
                </>
              ) : null}
              {sendingPaused ? (
                <>
                  {' '}
                  <Link href="/settings" className="underline underline-offset-4">
                    Settings
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
          {open && !draft.stale ? (
            <Button onClick={() => approve(false)} disabled={!ready} className="min-w-0 flex-1 sm:flex-none">
              {edited ? <Pencil aria-hidden="true" className="h-4 w-4" /> : <SendHorizontal aria-hidden="true" className="h-4 w-4" />}
              {pending ? 'Sending…' : edited ? 'Send edited reply' : 'Approve and send'}
              <kbd className="hidden rounded border border-primary-foreground/40 px-1 text-[10px] 2xl:inline">a</kbd>
            </Button>
          ) : null}
          {open && draft.stale ? (
            <Button onClick={() => approve(true)} disabled={!ready} variant="outline" className="min-w-0 flex-1 border-warning text-warning sm:flex-none">
              <SendHorizontal aria-hidden="true" className="h-4 w-4" />
              {pending ? 'Sending…' : 'Send anyway'}
            </Button>
          ) : null}
          {open && edited ? (
            <Button variant="ghost" size="sm" onClick={() => setText(draft.originalContent)} disabled={pending} className="shrink-0 max-sm:w-10 max-sm:px-0" aria-label="Undo edits">
              <RotateCcw aria-hidden="true" className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">Undo edits</span>
            </Button>
          ) : null}
          {draft.status === 'pending' ? (
            <Button variant="outline" size="sm" onClick={reject} disabled={pending} className="shrink-0 max-sm:w-10 max-sm:px-0" aria-label={draft.noReplyNeeded ? 'Dismiss' : 'Reject'}>
              <X aria-hidden="true" className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">{draft.noReplyNeeded ? 'Dismiss' : 'Reject'}</span>
              <kbd className="hidden rounded border border-border px-1 text-[10px] 2xl:inline">r</kbd>
            </Button>
          ) : null}
          {draft.status === 'pending' || failed ? (
            <Button variant="outline" size="sm" onClick={regenerate} disabled={pending || asked || aiPaused} className="shrink-0 max-sm:w-10 max-sm:px-0" aria-label={failed ? 'Try again' : 'Regenerate'} title={aiPaused ? 'AI drafting is paused in Settings' : undefined}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">{failed ? 'Try again' : 'Regenerate'}</span>
              <kbd className="hidden rounded border border-border px-1 text-[10px] 2xl:inline">g</kbd>
            </Button>
          ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link href={hrefFor(nextId ?? prevId)} className="underline underline-offset-4">
            {nextId ?? prevId ? 'Next draft' : 'Back to approvals'}
          </Link>
          <Link href={`/conversations/${draft.conversationId}`} className="underline underline-offset-4">
            Open conversation
          </Link>
        </div>
      )}

      <details className="rounded-md border border-border text-sm">
        <summary className="cursor-pointer px-3 py-2 font-medium">Why this draft</summary>
        <div className="space-y-2 border-t border-border px-3 py-2">
          <p>{draft.analysis || 'No analysis was recorded.'}</p>
          <p className="text-xs text-muted-foreground">
            Written by {draft.model} · prompt {draft.promptVersion} · {draft.styleGuideVersion === null ? 'no style guide yet' : `style guide v${draft.styleGuideVersion}`} ·{' '}
            {draft.fewshotCount} example repl{draft.fewshotCount === 1 ? 'y' : 'ies'} of yours used
          </p>
        </div>
      </details>

      {!failed ? <p className="text-xs text-muted-foreground">{describeEditRate(draft.stats, draft.intent)}</p> : null}
    </section>
  );
}

function Notice({ tone = 'neutral', title, children }: { tone?: 'neutral' | 'warning' | 'danger'; title: string; children?: React.ReactNode }) {
  const style =
    tone === 'danger' ? 'border-destructive/30 bg-destructive/5' : tone === 'warning' ? 'border-warning/40 bg-warning/10' : 'border-border bg-muted';
  return (
    <div role="status" className={`rounded-lg border p-3 text-sm ${style}`}>
      <p className="font-medium">{title}</p>
      {children ? <p className="mt-0.5 text-muted-foreground">{children}</p> : null}
    </div>
  );
}
