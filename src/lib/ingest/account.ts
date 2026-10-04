import type { AlertSeverity } from '@/lib/alerts';
import type { OtherItem } from '@/lib/whatsapp/webhook-schema';
import { type HandlerResult, type IngestContext, nothing } from './context';

/** `account_update` events that mean the business can no longer operate normally. Anything else is recorded only. */
const CRITICAL_ACCOUNT_EVENTS: ReadonlySet<string> = new Set([
  'PARTNER_REMOVED',
  'PARTNER_APP_UNINSTALLED',
  'ACCOUNT_VIOLATION',
  'ACCOUNT_DELETED',
  'ACCOUNT_RESTRICTION',
  'DISABLED_UPDATE',
]);

const DEGRADED_QUALITY_EVENTS: ReadonlySet<string> = new Set(['FLAGGED', 'DOWNGRADE']);

interface Classified {
  kind: string;
  severity: AlertSeverity;
}

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Account lifecycle and anything unrecognised. Returns what the owner should hear about, or null to record only. */
function classify(item: OtherItem): Classified | null {
  if (item.parseError === true) return { kind: 'webhook_unparseable', severity: 'warning' };
  const value = asRecord(item.value);

  switch (item.field) {
    case 'account_update': {
      const event = asString(value.event)?.toUpperCase();
      return event !== undefined && CRITICAL_ACCOUNT_EVENTS.has(event) ? { kind: `account_${event.toLowerCase()}`, severity: 'critical' } : null;
    }
    case 'account_offboarded':
      return { kind: 'account_offboarded', severity: 'critical' };
    case 'account_reconnected':
      return { kind: 'account_reconnected', severity: 'info' };
    case 'account_alerts':
    case 'account_review_update':
      return { kind: item.field, severity: 'warning' };
    case 'phone_number_quality_update': {
      const event = asString(value.event)?.toUpperCase();
      return event !== undefined && DEGRADED_QUALITY_EVENTS.has(event) ? { kind: 'phone_quality_degraded', severity: 'warning' } : null;
    }
    case 'phone_number_name_update': {
      const decision = asString(value.decision)?.toUpperCase();
      return decision !== undefined && decision !== 'APPROVED' ? { kind: 'phone_name_not_approved', severity: 'warning' } : null;
    }
    case 'messages':
      // The messages field carried a top-level `errors` array (split out by the splitter).
      return Array.isArray(value.errors) ? { kind: 'webhook_messages_error', severity: 'warning' } : null;
    default:
      return null;
  }
}

/**
 * Account and quality notifications, and payloads we parked because they did not match their schema. Nothing here can
 * change message data: the handler only decides whether to alert. The alert is keyed on the event so a replay is silent.
 */
export function handleOther(item: OtherItem, ctx: IngestContext): HandlerResult {
  const classified = classify(item);
  if (classified === null) return nothing(item.parseError === true ? undefined : 'field_recorded_only');

  const value = asRecord(item.value);
  const entityId = (asString(value.waba_id) ?? item.field).slice(0, 64);
  return {
    effects: [
      {
        type: 'alert',
        alert: { kind: classified.kind, severity: classified.severity, entityId, dedupeKey: `${classified.kind}:${ctx.eventKey}` },
      },
    ],
  };
}
