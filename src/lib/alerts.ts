import 'server-only';
import { getDb } from '@/lib/db';
import { notifications } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { publishEvent } from '@/lib/realtime/publish';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertInput {
  /** Short machine name, e.g. `webhook_unparseable`, `account_partner_removed`. Shown in the UI and logs. */
  kind: string;
  severity: AlertSeverity;
  /** What the alert is about (an id, never a message body). */
  entityId?: string;
  /** Alerts with the same key are raised once. Include a time bucket when the condition can legitimately recur. */
  dedupeKey: string;
}

/** Subscribers that turn an alert into something the owner sees (Telegram, from Phase 2). Failures never propagate. */
type AlertSink = (alert: AlertInput) => Promise<void>;
const sinks: AlertSink[] = [];

export function registerAlertSink(sink: AlertSink): void {
  sinks.push(sink);
}

/**
 * Raises an alert exactly once per `dedupeKey`: records it in `notifications` (the unique key is the dedupe), pushes an
 * `alert` event to the dashboard, and fans out to registered sinks. Returns false when it was already raised.
 * Raising an alert must never break the work that detected the problem, so every failure here is logged and swallowed.
 */
export async function raiseAlert(alert: AlertInput): Promise<boolean> {
  try {
    const inserted = await getDb()
      .insert(notifications)
      .values({ kind: `alert:${alert.kind}`, dedupeKey: alert.dedupeKey })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id });
    if (inserted.length === 0) return false;

    logger.warn({ alert: alert.kind, severity: alert.severity, entityId: alert.entityId }, 'alert raised');
    await publishEvent({
      type: 'alert',
      payload: { kind: alert.kind.slice(0, 64), ...(alert.entityId ? { entityId: alert.entityId.slice(0, 64) } : {}) },
    }).catch((error: Error) => logger.warn({ error: error.name }, 'alert event not published'));
    await Promise.all(sinks.map((sink) => sink(alert).catch((error: Error) => logger.warn({ error: error.name }, 'alert sink failed'))));
    return true;
  } catch (error) {
    logger.error({ alert: alert.kind, error: error instanceof Error ? error.name : 'unknown' }, 'could not raise alert');
    return false;
  }
}
