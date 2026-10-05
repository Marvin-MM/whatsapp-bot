'use client';

import { FileText, SendHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { sendMessage } from '@/actions/send';
import { useRouter } from 'next/navigation';
import { useNow } from '@/components/conversations/use-now';
import { Button } from '@/components/ui/button';
import { describeWindow, isWindowOpen, windowState } from '@/lib/conversations/window';
import { MAX_TEXT_LENGTH, PLACEHOLDER_PATTERN } from '@/lib/send/precheck';
import { newIdempotencyKey } from './new-key';
import { TemplatePicker } from './template-picker';

export interface ComposerProps {
  conversationId: string;
  windowExpiresAt: Date | null;
  serverNow: Date;
  sendingPaused: boolean;
  canReceive: boolean;
}

/**
 * The reply box. The server decides (the pre-check runs again, in a transaction, at send time and just before Meta is called);
 * this component mirrors the rules only so the owner sees WHY they cannot send before they type, not after.
 *
 * One idempotency key per composed message, reused on a retry: a double click, a slow network or a re-submitted form is one message.
 */
export function Composer({ conversationId, windowExpiresAt, serverNow, sendingPaused, canReceive }: ComposerProps) {
  const router = useRouter();
  const now = useNow(serverNow);
  const open = isWindowOpen(windowExpiresAt, now);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [pending, startTransition] = useTransition();
  const key = useRef(newIdempotencyKey());
  const box = useRef<HTMLTextAreaElement>(null);

  if (!canReceive) {
    return <Notice>This contact has no phone number yet, so there is nobody to send to. Replies from your phone still appear here.</Notice>;
  }
  if (sendingPaused) {
    return (
      <Notice tone="danger">
        Sending is paused, so nothing can be sent. <Link href="/settings" className="underline underline-offset-4">Turn it back on in Settings</Link>.
      </Notice>
    );
  }

  const trimmed = text.trim();
  const hasPlaceholder = PLACEHOLDER_PATTERN.test(text);
  const tooLong = text.length > MAX_TEXT_LENGTH;
  const canSend = open && trimmed !== '' && !hasPlaceholder && !tooLong && !pending;

  const submit = () => {
    if (!canSend) return;
    setError(null);
    startTransition(async () => {
      const result = await sendMessage({ conversationId, text, idempotencyKey: key.current });
      if (result.ok) {
        key.current = newIdempotencyKey();
        setText('');
        router.refresh();
        box.current?.focus();
      } else {
        // Kept: the text, and the key (a refusal wrote nothing; a failure is safe to retry because the key dedupes).
        setError(result.error.message);
      }
    });
  };

  const description = describeWindow(windowState(windowExpiresAt, now));

  return (
    <section aria-label="Reply" className="space-y-3">
      {open ? (
        <>
          <div className="flex items-end gap-2">
            <label htmlFor="reply-text" className="sr-only">
              Your reply
            </label>
            <textarea
              id="reply-text"
              ref={box}
              value={text}
              rows={2}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="Write a reply…"
              aria-describedby="reply-help"
              className="max-h-48 min-h-[3.25rem] flex-1 resize-y rounded-md border border-input bg-card px-3 py-2 text-base placeholder:text-muted-foreground md:text-sm"
            />
            <Button type="button" onClick={submit} disabled={!canSend} aria-label="Send" className="h-[3.25rem] shrink-0">
              <SendHorizontal aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">{pending ? 'Sending…' : 'Send'}</span>
            </Button>
          </div>
          <p id="reply-help" className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <span>Ctrl or ⌘ + Enter to send</span>
            {text.length > 3500 ? <span className={tooLong ? 'text-destructive' : ''}>{text.length}/{MAX_TEXT_LENGTH}</span> : null}
            {hasPlaceholder ? <span className="text-destructive">Replace the [[placeholder]] with the real answer before sending.</span> : null}
          </p>
        </>
      ) : (
        <Notice tone="danger">{description.detail}</Notice>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowTemplates((value) => !value)}
          aria-expanded={showTemplates || !open}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
        >
          <FileText aria-hidden="true" className="h-4 w-4" />
          {open ? (showTemplates ? 'Hide templates' : 'Send a template instead') : 'Templates'}
        </button>
        {showTemplates || !open ? (
          <div className="mt-2 rounded-lg border border-border bg-card p-3">
            <TemplatePicker conversationId={conversationId} onSent={() => router.refresh()} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Notice({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'danger' }) {
  return (
    <p role="status" className={tone === 'danger' ? 'rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm' : 'rounded-lg border border-border bg-muted p-3 text-sm'}>
      {children}
    </p>
  );
}
