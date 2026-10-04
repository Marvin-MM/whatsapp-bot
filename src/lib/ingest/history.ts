import 'server-only';
import { and, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { classifyIdentifier, sameNumber } from '@/lib/whatsapp/phone';
import type { HistoryItem, WebhookMessage } from '@/lib/whatsapp/webhook-schema';
import { type HandlerResult, type IngestContext, nothing } from './context';
import { type Identity, resolveContact } from './contacts';
import { refreshConversationAggregates } from './conversations';
import type { Effect } from './effects';
import { mediaJob } from './messages';
import { mapMessage, occurredAtOf } from './render';
import { echoCounterpart, inboundIdentity } from './sender';
import { applyStatus } from './statuses';

type StoredStatus = (typeof messages.$inferInsert)['status'];

/** Meta's `history_context.status` for an owner-side message. Anything unrecognised (ERROR, PENDING) is just `sent`. */
const HISTORY_STATUS: Readonly<Record<string, StoredStatus>> = { READ: 'read', PLAYED: 'read', DELIVERED: 'delivered', SENT: 'sent' };

const INSERT_BATCH = 200;

interface Candidate {
  message: WebhookMessage;
  /** The customer this thread belongs to, when the chunk is grouped into `threads[]`. */
  thread: string | undefined;
}

function chunkOf<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function threadIdentity(thread: string | undefined): Identity {
  const kind = classifyIdentifier(thread);
  if (kind === 'bsuid') return { bsuid: thread };
  if (kind === 'phone') return { phone: thread };
  return {};
}

/**
 * History has no direction field: a message is the owner's when it is FROM our own number, the customer's otherwise.
 * The customer is the thread id when the chunk is threaded; otherwise the sender (inbound) or the named recipient
 * (outbound). An owner-side message in a flat chunk that names no recipient cannot be attached to anyone and is counted
 * as unattributed instead of being filed under a guess.
 */
function historyIdentity(candidate: Candidate, direction: 'inbound' | 'outbound', ownNumber: string): Identity | null {
  const fromThread = threadIdentity(candidate.thread);
  const fromMessage = direction === 'inbound' ? inboundIdentity(candidate.message, undefined) : (echoCounterpart(candidate.message, ownNumber) ?? {});
  const identity: Identity = { bsuid: fromMessage.bsuid ?? fromThread.bsuid, phone: fromMessage.phone ?? fromThread.phone };
  return identity.bsuid === undefined && identity.phone === undefined ? null : identity;
}

/**
 * One history-sync chunk (Coexistence imports the owner's recent chats). Deliberately cheap and quiet: no drafts, no
 * dashboard events per message, no status changes. Inbound messages are the customer's (provenance `customer`), owner-side
 * ones are `imported` (what the style learner reads). New conversations are created `resolved`: this is the past.
 * Idempotent by `messages.wamid UNIQUE`, in any chunk order, so a replay or a duplicate chunk inserts nothing.
 */
export async function ingestHistory(tx: Tx, item: HistoryItem, ctx: IngestContext): Promise<HandlerResult> {
  if (!item.chunk) {
    const failed = item.errors !== undefined && item.errors.length > 0;
    return failed
      ? {
          effects: [{ type: 'alert', alert: { kind: 'history_sync_error', severity: 'warning', ...(item.request_id ? { entityId: item.request_id } : {}), dedupeKey: `history_sync_error:${ctx.eventKey}` } }],
          note: 'history_sync_error',
        }
      : nothing('history_empty');
  }
  if (ctx.ownNumber === null) {
    return {
      effects: [{ type: 'alert', alert: { kind: 'history_without_own_number', severity: 'warning', dedupeKey: `history_without_own_number:${ctx.eventKey}` } }],
      note: 'history_without_own_number',
    };
  }
  const ownNumber = ctx.ownNumber;

  const candidates: Candidate[] = [
    ...(item.chunk.messages ?? []).map((message) => ({ message, thread: undefined })),
    ...(item.chunk.threads ?? []).flatMap((thread) => thread.messages.map((message) => ({ message, thread: thread.id }))),
  ];

  const conversationByIdentity = new Map<string, string>();
  const rows: (typeof messages.$inferInsert)[] = [];
  let unattributed = 0;

  for (const candidate of candidates) {
    const { message } = candidate;
    // Groups are out of scope; system notices and edits/revokes are not conversation content in a history import.
    if (message.group_id || message.type === 'system' || message.edited === true || message.revoked === true) continue;

    const direction = sameNumber(message.from, ownNumber) ? 'outbound' : 'inbound';
    const identity = historyIdentity(candidate, direction, ownNumber);
    if (identity === null) {
      unattributed += 1;
      continue;
    }

    const cacheKey = `${identity.bsuid ?? ''}|${identity.phone ?? ''}`;
    let conversationId = conversationByIdentity.get(cacheKey);
    if (conversationId === undefined) {
      const resolved = await resolveContact(tx, identity, { conversationStatus: 'resolved' });
      if (!resolved?.conversation) {
        unattributed += 1;
        continue;
      }
      conversationId = resolved.conversation.id;
      conversationByIdentity.set(cacheKey, conversationId);
    }

    const mapped = mapMessage(message, { transcribeAudio: false, transcribable: false });
    rows.push({
      conversationId,
      direction,
      wamid: message.id,
      type: mapped.type,
      content: mapped.content,
      contentSource: mapped.contentSource,
      mediaId: mapped.mediaId,
      mediaMime: mapped.mediaMime,
      provenance: direction === 'inbound' ? 'customer' : 'imported',
      status: direction === 'inbound' ? 'received' : (HISTORY_STATUS[message.history_context?.status?.toUpperCase() ?? ''] ?? 'sent'),
      occurredAt: occurredAtOf(message, ctx.now),
    });
  }

  for (const batch of chunkOf(rows, INSERT_BATCH)) {
    await tx.insert(messages).values(batch).onConflictDoNothing({ target: messages.wamid });
  }
  for (const conversationId of new Set(conversationByIdentity.values())) await refreshConversationAggregates(tx, conversationId);

  // Recent media still has an id for ~14 days: fetch it. Derived from the rows, so a replay re-enqueues what is missing.
  const effects: Effect[] = [];
  const wamids = rows.filter((row) => row.mediaId).map((row) => row.wamid).filter((wamid): wamid is string => typeof wamid === 'string');
  for (const batch of chunkOf(wamids, INSERT_BATCH)) {
    const pending = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(inArray(messages.wamid, batch), isNotNull(messages.mediaId), isNull(messages.mediaPath)));
    for (const row of pending) effects.push(mediaJob(row.id));
  }

  // Delivery statuses for messages we may already hold. A status for a message in another chunk is not an error.
  for (const status of item.chunk.statuses ?? []) await applyStatus(tx, status);

  if (unattributed > 0) {
    effects.push({
      type: 'alert',
      alert: { kind: 'history_unattributed', severity: 'info', ...(item.request_id ? { entityId: item.request_id } : {}), dedupeKey: `history_unattributed:${ctx.eventKey}` },
    });
  }
  return unattributed > 0 ? { effects, note: `history_unattributed:${unattributed}` } : { effects };
}
