import { z } from 'zod';

/**
 * Dashboard realtime events (spec 5.4), published on Redis channel `{prefix}:dashboard`.
 *
 * Payloads carry IDs and minimal fields ONLY: no message bodies, names or phone numbers cross SSE.
 * Every payload is a strict object so a stray `body`/`content` field is rejected at publish time,
 * not discovered in production.
 */

const id = z.uuid();
const at = z.iso.datetime({ offset: true });

const event = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) =>
  z.strictObject({ type: z.literal(type), payload: z.strictObject(payload), at });

export const dashboardEventSchema = z.discriminatedUnion('type', [
  event('message:new', { conversationId: id, messageId: id }),
  event('message:status', {
    conversationId: id,
    messageId: id,
    status: z.enum(['received', 'queued', 'sent', 'delivered', 'read', 'failed', 'unknown']),
  }),
  event('draft:ready', { conversationId: id, draftId: id }),
  event('draft:updated', { conversationId: id, draftId: id, status: z.string().min(1).max(32) }),
  event('conversation:updated', { conversationId: id }),
  event('task:changed', { taskId: id, conversationId: id }),
  event('autopilot:scheduled', { conversationId: id, draftId: id, scheduledSendAt: at }),
  event('autopilot:sent', { conversationId: id, draftId: id, messageId: id }),
  event('autopilot:cancelled', { conversationId: id, draftId: id }),
  event('alert', { kind: z.string().min(1).max(64), entityId: z.string().max(64).optional() }),
]);

export type DashboardEvent = z.infer<typeof dashboardEventSchema>;
export type DashboardEventType = DashboardEvent['type'];

export const DASHBOARD_EVENT_TYPES: readonly DashboardEventType[] = dashboardEventSchema.options.map(
  (option) => option.shape.type.value,
);

/** Input for publishing: the timestamp is stamped at publish time. */
export type DashboardEventInput = { [K in DashboardEvent as K['type']]: Omit<K, 'at'> }[DashboardEventType];

export function dashboardChannel(prefix: string): string {
  return `${prefix}:dashboard`;
}

/** Parses a raw pub/sub message; returns null for anything that is not a valid event. */
export function parseDashboardEvent(raw: string): DashboardEvent | null {
  try {
    const result = dashboardEventSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
