import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@/lib/ids';
import {
  DASHBOARD_EVENT_TYPES,
  type DashboardEventType,
  dashboardChannel,
  dashboardEventSchema,
  parseDashboardEvent,
} from '@/lib/realtime/events';

const conversationId = uuidv7();
const messageId = uuidv7();
const draftId = uuidv7();
const taskId = uuidv7();
const at = '2026-10-04T12:00:00.000Z';

/** One valid payload per event type in spec 5.4. */
const VALID: Record<DashboardEventType, Record<string, unknown>> = {
  'message:new': { conversationId, messageId },
  'message:status': { conversationId, messageId, status: 'delivered' },
  'draft:ready': { conversationId, draftId },
  'draft:updated': { conversationId, draftId, status: 'superseded' },
  'conversation:updated': { conversationId },
  'task:changed': { taskId, conversationId },
  'autopilot:scheduled': { conversationId, draftId, scheduledSendAt: at },
  'autopilot:sent': { conversationId, draftId, messageId },
  'autopilot:cancelled': { conversationId, draftId },
  alert: { kind: 'token_invalid', entityId: 'abc' },
};

const SPEC_EVENT_TYPES = [
  'message:new',
  'message:status',
  'draft:ready',
  'draft:updated',
  'conversation:updated',
  'task:changed',
  'autopilot:scheduled',
  'autopilot:sent',
  'autopilot:cancelled',
  'alert',
];

describe('dashboard event catalog (spec 5.4)', () => {
  it('has exactly the ten events from the spec', () => {
    expect([...DASHBOARD_EVENT_TYPES].sort()).toEqual([...SPEC_EVENT_TYPES].sort());
    expect(Object.keys(VALID).sort()).toEqual([...SPEC_EVENT_TYPES].sort());
  });

  it.each(SPEC_EVENT_TYPES)('accepts a valid %s event', (type) => {
    expect(dashboardEventSchema.safeParse({ type, payload: VALID[type as DashboardEventType], at }).success).toBe(true);
  });

  it.each(SPEC_EVENT_TYPES)('rejects a %s event with an extra field, so message bodies can never ride SSE', (type) => {
    for (const leak of ['body', 'content', 'text', 'phone', 'displayName']) {
      const payload = { ...VALID[type as DashboardEventType], [leak]: 'private customer text' };
      expect(dashboardEventSchema.safeParse({ type, payload, at }).success, `${type} accepted ${leak}`).toBe(false);
    }
  });

  it('rejects an extra top-level field', () => {
    expect(dashboardEventSchema.safeParse({ type: 'alert', payload: VALID.alert, at, body: 'x' }).success).toBe(false);
  });

  it('rejects unknown types, non-uuid ids, and bad timestamps', () => {
    expect(dashboardEventSchema.safeParse({ type: 'message:deleted', payload: {}, at }).success).toBe(false);
    expect(dashboardEventSchema.safeParse({ type: 'message:new', payload: { conversationId: '123', messageId }, at }).success).toBe(false);
    expect(dashboardEventSchema.safeParse({ type: 'draft:ready', payload: VALID['draft:ready'], at: 'yesterday' }).success).toBe(false);
  });

  it('rejects unknown message statuses', () => {
    expect(
      dashboardEventSchema.safeParse({ type: 'message:status', payload: { conversationId, messageId, status: 'teleported' }, at }).success,
    ).toBe(false);
  });
});

describe('parseDashboardEvent', () => {
  it('parses a valid raw message', () => {
    const raw = JSON.stringify({ type: 'conversation:updated', payload: { conversationId }, at });
    expect(parseDashboardEvent(raw)).toEqual({ type: 'conversation:updated', payload: { conversationId }, at });
  });

  it('returns null for invalid JSON, wrong shapes, and non-objects instead of throwing', () => {
    expect(parseDashboardEvent('not json')).toBeNull();
    expect(parseDashboardEvent('{"type":"alert"}')).toBeNull();
    expect(parseDashboardEvent('42')).toBeNull();
    expect(parseDashboardEvent('null')).toBeNull();
  });
});

describe('dashboardChannel', () => {
  it('namespaces the channel by prefix so test and dev instances never cross-talk (pub/sub ignores Redis db index)', () => {
    expect(dashboardChannel('wab')).toBe('wab:dashboard');
    expect(dashboardChannel('wab-test')).toBe('wab-test:dashboard');
  });
});
