import { CornerUpLeft, Download, Pencil } from 'lucide-react';
import { TRANSCRIPT_LABEL, UNRELIABLE_LABEL } from '@/lib/ai/transcribe';
import { formatClock, formatFullTimestamp } from '@/lib/conversations/format';
import type { ThreadMessage } from '@/lib/conversations/queries';
import { cn } from '@/lib/utils';
import { UnknownMessageActions } from '@/components/send/unknown-message-actions';
import { DeliveryStatus } from './delivery-status';

const PROVENANCE_LABEL: Partial<Record<ThreadMessage['provenance'], string>> = {
  owner_app_echo: 'Sent from your phone',
  imported: 'Imported',
  ai_unedited: 'AI draft, approved as written',
  ai_edited: 'AI draft, edited by you',
  ai_autopilot: 'Auto-reply',
};

function Media({ message }: { message: ThreadMessage }) {
  const { media } = message;
  if (media.state === 'pending') return <p className="text-xs italic opacity-80">Downloading…</p>;
  if (media.state === 'unavailable') return <p className="text-xs italic opacity-80">Not available (Meta no longer has this file)</p>;
  if (media.state !== 'ready' || media.url === null) return null;

  switch (message.type) {
    case 'image':
      return (
        <a href={media.url} target="_blank" rel="noopener noreferrer" className="block">
          {/* A private, authenticated, never-cached route: next/image's optimiser cannot (and must not) proxy it. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={media.url} alt="Photo sent in this chat" loading="lazy" className="max-h-72 max-w-full rounded-lg" />
        </a>
      );
    case 'sticker':
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={media.url} alt="Sticker" loading="lazy" className="max-h-32 max-w-full" />;
    case 'audio':
      return <audio controls preload="none" src={media.url} className="w-64 max-w-full" />;
    case 'video':
      return <video controls preload="metadata" src={media.url} className="max-h-72 max-w-full rounded-lg" />;
    default:
      return (
        <a href={media.url} className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4">
          <Download aria-hidden="true" className="h-4 w-4" />
          Download file
        </a>
      );
  }
}

/** What to show as text. A placeholder like "[Image]" is hidden once the real thing is on screen; a transcript is labelled. */
function Body({ message }: { message: ThreadMessage }) {
  if (message.deleted) return <span className="italic opacity-80">This message was deleted</span>;
  const { content, contentSource } = message;
  if (content === null || content === '') return null;

  if (contentSource === 'transcript') {
    const text = content.startsWith(TRANSCRIPT_LABEL) ? content.slice(TRANSCRIPT_LABEL.length).trim() : content;
    return (
      <div className="space-y-1">
        <span className="inline-block rounded border border-current/30 px-1.5 text-[11px] uppercase tracking-wide opacity-80">Auto-transcribed · may contain errors</span>
        <p className="italic">{text}</p>
      </div>
    );
  }
  if (message.transcriptionStatus === 'low_confidence' && content === UNRELIABLE_LABEL) {
    return <p className="italic opacity-90">The automatic transcript was unreliable. Please listen to the voice message.</p>;
  }
  if (contentSource === 'rendered' && message.media.state === 'ready') return null;
  return <p>{content}</p>;
}

function Quote({ replyTo }: { replyTo: NonNullable<ThreadMessage['replyTo']> }) {
  return (
    <a
      href={`#m-${replyTo.id}`}
      className="mb-1 block rounded-md border-l-2 border-current/40 bg-black/5 px-2 py-1 text-xs opacity-90 dark:bg-white/10"
    >
      <span className="inline-flex items-center gap-1 font-medium">
        <CornerUpLeft aria-hidden="true" className="h-3 w-3" />
        {replyTo.direction === 'inbound' ? 'Customer' : 'You'}
      </span>
      <span className="block truncate">{replyTo.preview}</span>
    </a>
  );
}

/** Meta's numeric error code helps when asking for support; our own internal reasons (`resent`, `window_closed`) are not for the owner to read. */
export function metaCodeSuffix(code: string | null): string {
  return code !== null && /^\d+$/.test(code) ? ` (code ${code})` : '';
}

export function MessageBubble({ message, timeZone }: { message: ThreadMessage; timeZone: string }) {
  const inbound = message.direction === 'inbound';
  const provenance = inbound ? undefined : PROVENANCE_LABEL[message.provenance];

  return (
    <li id={`m-${message.id}`} className={cn('flex scroll-mt-24 flex-col gap-1', inbound ? 'items-start' : 'items-end')}>
      <div
        className={cn(
          'max-w-[88%] space-y-1.5 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm sm:max-w-[75%]',
          inbound ? 'rounded-bl-sm bg-muted text-foreground' : 'rounded-br-sm bg-primary text-primary-foreground',
        )}
      >
        <span className="sr-only">{inbound ? 'Customer: ' : 'You: '}</span>
        {message.replyTo ? <Quote replyTo={message.replyTo} /> : null}
        <Media message={message} />
        <Body message={message} />
      </div>

      {message.reactions.length > 0 ? (
        <ul aria-label="Reactions" className="-mt-2 flex gap-1 px-2">
          {message.reactions.map((reaction) => (
            <li
              key={reaction.by}
              title={reaction.by === 'customer' ? 'Customer reacted' : 'You reacted'}
              className="rounded-full border border-border bg-card px-1.5 text-xs shadow-sm"
            >
              <span aria-hidden="true">{reaction.emoji}</span>
              <span className="sr-only">{reaction.by === 'customer' ? 'Customer reacted' : 'You reacted'} {reaction.emoji}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-xs text-muted-foreground">
        <time dateTime={message.occurredAt.toISOString()} title={formatFullTimestamp(message.occurredAt, timeZone)}>
          {formatClock(message.occurredAt, timeZone)}
        </time>
        {message.editedAt && !message.deleted ? (
          <span className="inline-flex items-center gap-0.5">
            <Pencil aria-hidden="true" className="h-3 w-3" />
            edited
          </span>
        ) : null}
        {provenance ? <span>{provenance}</span> : null}
        {!inbound ? <DeliveryStatus status={message.status} /> : null}
      </div>
      {!inbound && message.status === 'unknown' ? <UnknownMessageActions messageId={message.id} canResend={message.type === 'text'} /> : null}
      {!inbound && message.status === 'failed' && message.error ? (
        <p className="px-1 text-xs text-destructive">
          {message.error.message}
          {metaCodeSuffix(message.error.code)}
        </p>
      ) : null}
    </li>
  );
}
