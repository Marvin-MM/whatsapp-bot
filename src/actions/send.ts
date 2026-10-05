'use server';

import { z } from 'zod';
import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { announceQueued, markMessageSent, queueMessage, resendMessage } from '@/lib/send/send-message';
import { refusingOnSendRefused } from '@/lib/send/refusal';
import { readCachedTemplates } from '@/lib/whatsapp/templates-client';
import { resolveTemplate } from '@/lib/whatsapp/templates';
import { ownerAction } from './owner-action';

/** The client makes one key per composed message and reuses it on retry: a double click or a re-sent request is one message. The colon is reserved for `resend:`. */
const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

export interface SentMessage {
  messageId: string;
  conversationId: string;
  duplicate: boolean;
}

const sendTextSchema = z.object({
  conversationId: z.uuid(),
  // Generous bound only to refuse absurd payloads early; the pre-check enforces WhatsApp's real limit with a readable message.
  text: z.string().max(20_000),
  idempotencyKey,
});

const sendText = ownerAction({
  name: 'send.text',
  schema: sendTextSchema,
  handler: async ({ input, tx }) => {
    const queued = await refusingOnSendRefused(() =>
      queueMessage(tx, { conversationId: input.conversationId, message: { kind: 'text', content: input.text }, idempotencyKey: input.idempotencyKey, source: { kind: 'manual' } }),
    );
    return {
      data: { messageId: queued.messageId, conversationId: queued.conversationId, duplicate: queued.duplicate } satisfies SentMessage,
      // Never the message body: the audit log is for "who did what", not a second copy of the conversation.
      audit: { action: 'message.send', entityType: 'message', entityId: queued.messageId, metadata: { conversationId: queued.conversationId, kind: 'text', length: input.text.length, duplicate: queued.duplicate } },
      afterCommit: () => announceQueued(queued),
    };
  },
});

/** Sends a typed reply. Refused (with a reason the owner can read) when the window is closed, sending is paused, or the text breaks a rule. */
export async function sendMessage(input: unknown): Promise<ActionResult<SentMessage>> {
  return sendText(input);
}

const sendTemplateSchema = z.object({
  conversationId: z.uuid(),
  /** `${name}/${language}`, as listed by `listTemplates`. */
  templateKey: z.string().min(3).max(300),
  values: z.record(z.string().max(100), z.string().max(2_000)),
  idempotencyKey,
});

const sendTemplateAction = ownerAction({
  name: 'send.template',
  schema: sendTemplateSchema,
  handler: async ({ input, tx }) => {
    // The cache only: no network call while a database transaction is open. The picker loaded it moments ago.
    const list = await readCachedTemplates();
    if (!list) throw new ActionRefusal('templates_unavailable', 'The template list has expired. Reopen the template picker and try again.');
    const summary = list.templates.find((template) => template.key === input.templateKey);
    if (!summary) throw new ActionRefusal('template_not_found', 'That template is no longer in your list. Reopen the template picker.');
    const resolved = resolveTemplate(summary, input.values);
    if (!resolved.ok) throw new ActionRefusal('template_invalid', [resolved.error, ...resolved.problems.map((problem) => `${problem.param}: ${problem.message}`)].join(' '));

    const queued = await refusingOnSendRefused(() =>
      queueMessage(tx, {
        conversationId: input.conversationId,
        message: { kind: 'template', template: resolved.resolved },
        idempotencyKey: input.idempotencyKey,
        source: { kind: 'manual' },
      }),
    );
    return {
      data: { messageId: queued.messageId, conversationId: queued.conversationId, duplicate: queued.duplicate } satisfies SentMessage,
      audit: {
        action: 'message.send_template',
        entityType: 'message',
        entityId: queued.messageId,
        metadata: { conversationId: queued.conversationId, template: summary.name, language: summary.language, duplicate: queued.duplicate },
      },
      afterCommit: () => announceQueued(queued),
    };
  },
});

/** Sends an approved template (the only thing allowed outside the 24-hour window). Values are checked against the template; nothing is guessed. */
export async function sendTemplate(input: unknown): Promise<ActionResult<SentMessage>> {
  return sendTemplateAction(input);
}

const messageIdSchema = z.object({ messageId: z.uuid() });

const markSentAction = ownerAction({
  name: 'send.markSent',
  schema: messageIdSchema,
  handler: async ({ input, tx }) => {
    const { conversationId } = await refusingOnSendRefused(() => markMessageSent(tx, input.messageId));
    return {
      data: { messageId: input.messageId, conversationId },
      audit: { action: 'message.mark_sent', entityType: 'message', entityId: input.messageId, metadata: { conversationId } },
    };
  },
});

/** "I checked my phone: it did arrive." Only for a message whose delivery is `unknown`. */
export async function markSent(input: unknown): Promise<ActionResult<{ messageId: string; conversationId: string }>> {
  return markSentAction(input);
}

const resendAction = ownerAction({
  name: 'send.resend',
  schema: messageIdSchema,
  handler: async ({ input, tx }) => {
    const queued = await refusingOnSendRefused(() => resendMessage(tx, input.messageId));
    return {
      data: { messageId: queued.messageId, conversationId: queued.conversationId, duplicate: queued.duplicate } satisfies SentMessage,
      audit: { action: 'message.resend', entityType: 'message', entityId: queued.messageId, metadata: { conversationId: queued.conversationId, original: input.messageId } },
      afterCommit: () => announceQueued(queued),
    };
  },
});

/** "I checked my phone: it did NOT arrive." Closes the original and sends the same text again as a new message. */
export async function resend(input: unknown): Promise<ActionResult<SentMessage>> {
  return resendAction(input);
}
