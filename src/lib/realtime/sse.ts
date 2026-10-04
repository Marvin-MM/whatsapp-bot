import 'server-only';
import { logger } from '@/lib/logger';
import type { DashboardHub } from './hub';

/**
 * Server-Sent Events for the dashboard (spec 5.4). The owner is one person with a handful of tabs, so the limits are about
 * safety, not scale: a cap on open streams, a heartbeat that keeps proxies from closing an idle one, closing a stream whose
 * reader has stopped keeping up, and re-checking the session so signing out (or a revoked session) ends the stream.
 */
export const MAX_STREAMS = 20;
export const HEARTBEAT_MS = 25_000;
export const RECHECK_MS = 5 * 60_000;
/** A reader this many chunks behind is not reading: drop it rather than buffer for it forever. */
const SLOW_CONSUMER_BACKLOG = 64;

let active = 0;

/** Open streams in this process (tests and the health page). */
export const activeStreams = (): number => active;

export interface EventStreamOptions {
  hub: DashboardHub;
  /** The request's abort signal: the client went away. */
  signal: AbortSignal;
  /** Resolves false when the session is no longer valid; the stream then ends. */
  recheck?: () => Promise<boolean>;
  heartbeatMs?: number;
  recheckMs?: number;
  maxStreams?: number;
}

const encoder = new TextEncoder();

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform stops intermediaries compressing (and therefore buffering) the stream; X-Accel-Buffering does the same for nginx.
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
};

export function eventStreamResponse(options: EventStreamOptions): Response {
  if (active >= (options.maxStreams ?? MAX_STREAMS)) {
    return new Response('Too many open streams', { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } });
  }
  active += 1;

  let closeStream: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        const timers: { heartbeat?: NodeJS.Timeout; recheck?: NodeJS.Timeout } = {};

        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timers.heartbeat);
          clearInterval(timers.recheck);
          unsubscribe?.();
          active -= 1;
          try {
            controller.close();
          } catch {
            // Already closed or cancelled by the client.
          }
        };
        closeStream = close;

        const send = (text: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            close();
            return;
          }
          if ((controller.desiredSize ?? 0) < -SLOW_CONSUMER_BACKLOG) {
            logger.warn('closing a dashboard stream whose reader stopped reading');
            close();
          }
        };

        options.signal.addEventListener('abort', close, { once: true });
        if (options.signal.aborted) {
          close();
          return;
        }
        // `retry` tells EventSource how long to wait before reconnecting; the comment flushes headers through proxies at once.
        send('retry: 3000\n\n');
        send(': connected\n\n');

        options.hub
          .subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`))
          .then((stop) => {
            if (closed) stop();
            else unsubscribe = stop;
          })
          .catch((error: unknown) => {
            logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'dashboard stream could not subscribe');
            close();
          });

        timers.heartbeat = setInterval(() => send(': ping\n\n'), options.heartbeatMs ?? HEARTBEAT_MS);
        if (options.recheck) {
          const check = options.recheck;
          timers.recheck = setInterval(() => {
            void check()
              .then((valid) => {
                if (!valid) close();
              })
              .catch(() => close());
          }, options.recheckMs ?? RECHECK_MS);
        }
      },
      cancel() {
        closeStream();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 16 }),
  );
  return new Response(stream, { headers: SSE_HEADERS });
}
