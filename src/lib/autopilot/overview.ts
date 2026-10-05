import 'server-only';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { displayName } from '@/lib/conversations/display';
import type { Db } from '@/lib/db';
import { contacts, conversations, drafts, messages, settings } from '@/lib/db/schema';
import { ALLOWABLE_INTENTS, type AutopilotSettingsInput } from './settings';

/** The lists on Settings -> Autopilot: what is configured, who is on autopilot, what is counting down, and what the owner flagged. */

export interface AutopilotConversationRow {
  conversationId: string;
  name: string;
  until: Date | null;
}

export interface ScheduledSendRow {
  draftId: string;
  conversationId: string;
  name: string;
  sendAt: Date | null;
}

export interface MarkedBadRow {
  messageId: string;
  conversationId: string;
  name: string;
  markedAt: Date;
}

export interface AutopilotOverview {
  settings: AutopilotSettingsInput;
  conversations: AutopilotConversationRow[];
  scheduled: ScheduledSendRow[];
  markedBad: MarkedBadRow[];
}

const LIST_LIMIT = 50;
const MARKED_BAD_LIMIT = 10;

const nameColumns = { displayName: contacts.displayName, username: contacts.username, phoneE164: contacts.phoneE164, bsuid: contacts.bsuid };

export async function getAutopilotOverview(db: Db): Promise<AutopilotOverview> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1);

  const onAutopilot = await db
    .select({ conversationId: conversations.id, until: conversations.autopilotUntil, ...nameColumns })
    .from(conversations)
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.replyMode, 'autopilot'))
    .orderBy(desc(conversations.updatedAt))
    .limit(LIST_LIMIT);

  const scheduled = await db
    .select({ draftId: drafts.id, conversationId: drafts.conversationId, sendAt: drafts.scheduledSendAt, ...nameColumns })
    .from(drafts)
    .innerJoin(conversations, eq(conversations.id, drafts.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(drafts.status, 'scheduled'))
    .orderBy(drafts.scheduledSendAt)
    .limit(LIST_LIMIT);

  const markedBad = await db
    .select({ messageId: messages.id, conversationId: messages.conversationId, markedAt: messages.markedBadAt, ...nameColumns })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(and(isNotNull(messages.markedBadAt), eq(messages.provenance, 'ai_autopilot')))
    .orderBy(desc(messages.markedBadAt))
    .limit(MARKED_BAD_LIMIT);

  return {
    settings: {
      delaySeconds: row?.autopilotDelaySeconds ?? 120,
      maxPerConversationPerHour: row?.autopilotMaxPerConversationPerHour ?? 3,
      maxPerDay: row?.autopilotMaxPerDay ?? 30,
      maxConsecutive: row?.autopilotMaxConsecutive ?? 4,
      // Only intents the form can offer: a stored value outside the list (an old row) is simply not shown as ticked.
      allowedIntents: (row?.autopilotAllowedIntents ?? ['chit_chat', 'question']).filter((intent) => ALLOWABLE_INTENTS.includes(intent as (typeof ALLOWABLE_INTENTS)[number])),
      disclosure: row?.autopilotDisclosure ?? '(sent by my assistant)',
    },
    conversations: onAutopilot.map((item) => ({ conversationId: item.conversationId, name: displayName(item), until: item.until })),
    scheduled: scheduled.map((item) => ({ draftId: item.draftId, conversationId: item.conversationId, name: displayName(item), sendAt: item.sendAt })),
    markedBad: markedBad.flatMap((item) => (item.markedAt ? [{ messageId: item.messageId, conversationId: item.conversationId, name: displayName(item), markedAt: item.markedAt }] : [])),
  };
}
