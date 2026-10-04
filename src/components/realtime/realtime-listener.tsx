'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type ConnectionState = 'connecting' | 'live' | 'reconnecting';

const REFRESH_DEBOUNCE_MS = 300;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** Exponential backoff with jitter, capped: a flapping server is not hammered by every open tab at once. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.round(exponential / 2 + (random() * exponential) / 2);
}

/**
 * Keeps the dashboard live. It opens the server-sent event stream and, on any event, asks Next to re-render the current
 * page's server components (`router.refresh()`), debounced so a burst of events is one refresh. Client state is preserved.
 *
 * Reconnection is manual rather than left to EventSource: the browser retries a dropped connection but gives up for good
 * on an HTTP error (401 after the session expires, 503 when the server is at its stream limit). On every reconnect we refresh
 * once, because events published while we were disconnected are gone: the page re-reads the truth instead.
 * Events carry no content, only that something changed, so nothing sensitive crosses the stream.
 */
export function RealtimeListener() {
  const router = useRouter();
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let lostConnection = false;
    let stopped = false;

    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource('/api/events');
      source.onopen = () => {
        attempt = 0;
        setState('live');
        if (lostConnection) {
          lostConnection = false;
          refresh();
        }
      };
      source.onmessage = (message: MessageEvent<string>) => {
        try {
          const event: unknown = JSON.parse(message.data);
          if (typeof event === 'object' && event !== null && typeof (event as { type?: unknown }).type === 'string') refresh();
        } catch {
          // Not an event we understand (a comment never reaches here); ignore rather than refresh on garbage.
        }
      };
      source.onerror = () => {
        source?.close();
        source = null;
        lostConnection = true;
        setState('reconnecting');
        reconnectTimer = setTimeout(connect, backoffDelay(attempt));
        attempt += 1;
      };
    };

    // A tab that was in the background may have missed anything: re-read when it comes back.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();

    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(reconnectTimer);
      clearTimeout(refreshTimer);
      source?.close();
    };
  }, [router]);

  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-state={state}>
      <span
        aria-hidden="true"
        className={cn('h-2 w-2 rounded-full', state === 'live' ? 'bg-success' : 'animate-pulse bg-warning')}
      />
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </span>
  );
}
