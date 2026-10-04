import { sha256Hex, stableStringify } from '@/lib/hash';
import {
  type Envelope,
  appStateFieldValueSchema,
  echoFieldValueSchema,
  historyFieldValueSchema,
  messagesFieldValueSchema,
  userIdUpdateFieldValueSchema,
  userPreferencesFieldValueSchema,
} from './webhook-schema';

export type EventKind =
  | 'message'
  | 'status'
  | 'echo'
  | 'history'
  | 'app_state'
  | 'user_id_update'
  | 'user_preferences'
  | 'account'
  | 'other';

export interface SplitItem {
  /** Unique per event; the webhook_events.dedupe_key and the BullMQ job id (percent-encoded). */
  dedupeKey: string;
  kind: EventKind;
  /** Self-contained JSON (metadata + contacts + the single message/status/chunk), so each row is processable alone. */
  item: Record<string, unknown>;
}

/** Account lifecycle and quality fields: kept verbatim and surfaced as alerts by the processor. */
export const ACCOUNT_FIELDS: ReadonlySet<string> = new Set([
  'account_update',
  'account_offboarded',
  'account_reconnected',
  'account_alerts',
  'account_review_update',
  'phone_number_quality_update',
  'phone_number_name_update',
]);

const digest = (value: unknown): string => sha256Hex(stableStringify(value));

/*
 * Dedupe keys for events with no natural id (account state, app-state syncs, preferences) hash the payload PLUS the
 * entry's `time`. Meta resends the same entry (same time) on a retry, so replays still collapse; but a state that
 * legitimately recurs (quality GREEN -> YELLOW -> GREEN -> YELLOW, a contact renamed back to its old name) has a new
 * time and is processed again instead of being dropped as a duplicate of the first occurrence.
 */

/** An edit or revoke may reuse an id; the suffix keeps it from being deduped away as a replay of the original. */
function flagSuffix(message: { edited?: boolean | undefined; revoked?: boolean | undefined }): string {
  if (message.revoked) return ':revoked';
  if (message.edited) return ':edited';
  return '';
}

function park(field: string, value: unknown): SplitItem {
  return { dedupeKey: `other:${field}:${digest(value)}`, kind: 'other', item: { field, value, parseError: true } };
}

function splitMessagesField(value: unknown, entryTime: number | undefined): SplitItem[] {
  const parsed = messagesFieldValueSchema.safeParse(value);
  if (!parsed.success) return [park('messages', value)];
  const { metadata, contacts, messages = [], statuses = [], errors } = parsed.data;
  const items: SplitItem[] = [];

  for (const message of messages) {
    items.push({
      dedupeKey: `msg:${message.id}${flagSuffix(message)}`,
      kind: 'message',
      item: { field: 'messages', metadata, contacts, message },
    });
  }
  for (const status of statuses) {
    items.push({
      dedupeKey: `status:${status.id}:${status.status}`,
      kind: 'status',
      item: { field: 'messages', metadata, contacts, status },
    });
  }
  if (errors && errors.length > 0) {
    items.push({
      dedupeKey: `other:messages-errors:${digest({ entryTime, errors })}`,
      kind: 'other',
      item: { field: 'messages', value: { metadata, errors } },
    });
  }
  return items;
}

function splitEchoField(value: unknown): SplitItem[] {
  const parsed = echoFieldValueSchema.safeParse(value);
  if (!parsed.success) return [park('smb_message_echoes', value)];
  const { metadata, message_echoes = [], messages = [] } = parsed.data;
  return [...message_echoes, ...messages].map((message) => ({
    dedupeKey: `echo:${message.id}${flagSuffix(message)}`,
    kind: 'echo' as const,
    item: { field: 'smb_message_echoes', metadata, message },
  }));
}

function splitHistoryField(value: unknown): SplitItem[] {
  const parsed = historyFieldValueSchema.safeParse(value);
  if (!parsed.success) return [park('history', value)];
  const { metadata, request_id: requestId, errors, history = [] } = parsed.data;
  const request = requestId ?? 'none';
  const items: SplitItem[] = [];

  for (const chunk of history) {
    const phase = chunk.phase ?? chunk.metadata?.phase ?? 'none';
    items.push({
      // Chunk-level dedupe (D-033): one job per chunk; message idempotency comes from messages.wamid UNIQUE.
      dedupeKey: `history:${request}:${phase}:${digest(chunk)}`,
      kind: 'history',
      item: { field: 'history', metadata, request_id: requestId, chunk },
    });
  }
  if (errors && errors.length > 0) {
    items.push({
      dedupeKey: `history-error:${request}:${digest(errors)}`,
      kind: 'history',
      item: { field: 'history', metadata, request_id: requestId, errors },
    });
  }
  return items;
}

function splitAppStateField(value: unknown, entryTime: number | undefined): SplitItem[] {
  const parsed = appStateFieldValueSchema.safeParse(value);
  if (!parsed.success) return [park('smb_app_state_sync', value)];
  const { metadata, request_id: requestId, contacts = [], errors } = parsed.data;
  const items: SplitItem[] = contacts.map((contact) => ({
    dedupeKey: `appstate:${digest({ entryTime, requestId, contact })}`,
    kind: 'app_state' as const,
    item: { field: 'smb_app_state_sync', metadata, request_id: requestId, contact },
  }));
  if (errors && errors.length > 0) {
    items.push({
      dedupeKey: `appstate-error:${digest({ entryTime, requestId, errors })}`,
      kind: 'app_state',
      item: { field: 'smb_app_state_sync', metadata, request_id: requestId, errors },
    });
  }
  return items;
}

function splitUserIdUpdateField(value: unknown): SplitItem[] {
  const parsed = userIdUpdateFieldValueSchema.safeParse(value);
  if (!parsed.success) return [park('user_id_update', value)];
  const { metadata, user_id_update: updates } = parsed.data;
  return updates.map((update) => ({
    dedupeKey: `uidupd:${update.user_id.previous}:${update.user_id.current}`,
    kind: 'user_id_update' as const,
    item: { field: 'user_id_update', metadata, update },
  }));
}

function splitUserPreferencesField(value: unknown, entryTime: number | undefined): SplitItem[] {
  const parsed = userPreferencesFieldValueSchema.safeParse(value);
  if (!parsed.success) return [park('user_preferences', value)];
  const { metadata, user_preferences: preferences } = parsed.data;
  return preferences.map((preference) => ({
    dedupeKey: `userpref:${digest({ entryTime, preference })}`,
    kind: 'user_preferences' as const,
    item: { field: 'user_preferences', metadata, preference },
  }));
}

function splitChange(field: string, value: unknown, entryTime: number | undefined): SplitItem[] {
  switch (field) {
    case 'messages':
      return splitMessagesField(value, entryTime);
    case 'smb_message_echoes':
      return splitEchoField(value);
    case 'history':
      return splitHistoryField(value);
    case 'smb_app_state_sync':
      return splitAppStateField(value, entryTime);
    case 'user_id_update':
      return splitUserIdUpdateField(value);
    case 'user_preferences':
      return splitUserPreferencesField(value, entryTime);
    default: {
      const kind: EventKind = ACCOUNT_FIELDS.has(field) ? 'account' : 'other';
      return [{ dedupeKey: `${kind}:${field}:${digest({ entryTime, value })}`, kind, item: { field, value } }];
    }
  }
}

/**
 * Splits a validated envelope into independent events. Iterates EVERY entry and change (Meta batches many per POST;
 * never assume index 0). Pure and deterministic: the same payload always yields the same keys in the same order, and
 * a key repeated inside one payload is kept once.
 */
export function splitEnvelope(envelope: Envelope): SplitItem[] {
  const seen = new Set<string>();
  const out: SplitItem[] = [];
  for (const entry of envelope.entry) {
    for (const change of entry.changes) {
      for (const item of splitChange(change.field, change.value, entry.time)) {
        if (seen.has(item.dedupeKey)) continue;
        seen.add(item.dedupeKey);
        out.push(item);
      }
    }
  }
  return out;
}
