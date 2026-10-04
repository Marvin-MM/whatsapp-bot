import 'server-only';
import { Redis } from 'ioredis';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { type DashboardEvent, dashboardChannel, parseDashboardEvent } from './events';

type Listener = (event: DashboardEvent) => void;

export interface DashboardHub {
  /** Starts delivering validated events to `listener`; resolves once the subscription is live. Returns the unsubscribe. */
  subscribe: (listener: Listener) => Promise<() => void>;
  size: () => number;
  close: () => Promise<void>;
}

/**
 * ONE Redis subscriber per web process fans every dashboard event out to all open SSE streams (a Redis connection per browser
 * tab would be a connection leak waiting to happen). Every message is re-validated against the strict event schema before it
 * is forwarded: anything malformed, or carrying a field the schema does not allow (a message body, say), is dropped here
 * even if some other publisher were to put it on the channel.
 */
export function createDashboardHub(url: string, channel: string): DashboardHub {
  const listeners = new Set<Listener>();
  let subscriber: Redis | undefined;
  let starting: Promise<void> | undefined;

  const start = (): Promise<void> => {
    starting ??= (async () => {
      const connection = new Redis(url, { maxRetriesPerRequest: null });
      // An unhandled 'error' event would crash the process; ioredis reconnects and resubscribes by itself.
      connection.on('error', (error: Error) => logger.warn({ error: error.name }, 'dashboard hub redis error'));
      connection.on('message', (_channel: string, raw: string) => {
        const event = parseDashboardEvent(raw);
        if (!event) return;
        for (const listener of [...listeners]) {
          try {
            listener(event);
          } catch (error) {
            logger.warn({ error: error instanceof Error ? error.name : 'unknown' }, 'dashboard listener threw');
          }
        }
      });
      subscriber = connection;
      await connection.subscribe(channel);
    })().catch((error: unknown) => {
      // Let the next subscriber try again instead of caching the failure forever.
      starting = undefined;
      throw error;
    });
    return starting;
  };

  return {
    async subscribe(listener) {
      listeners.add(listener);
      try {
        await start();
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      return () => {
        listeners.delete(listener);
      };
    },
    size: () => listeners.size,
    async close() {
      listeners.clear();
      const connection = subscriber;
      subscriber = undefined;
      starting = undefined;
      await connection?.quit().catch(() => connection.disconnect());
    },
  };
}

// In development Next re-evaluates modules on every edit; cache on globalThis so a hub is never leaked per edit.
const globalForHub = globalThis as unknown as { __wabHub?: DashboardHub };

export function getDashboardHub(): DashboardHub {
  const env = getEnv();
  globalForHub.__wabHub ??= createDashboardHub(env.REDIS_URL, dashboardChannel(env.BULLMQ_PREFIX));
  return globalForHub.__wabHub;
}

export async function closeDashboardHub(): Promise<void> {
  const hub = globalForHub.__wabHub;
  globalForHub.__wabHub = undefined;
  await hub?.close();
}
