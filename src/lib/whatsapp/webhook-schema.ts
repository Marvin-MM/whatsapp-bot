import { z } from 'zod';

/**
 * Zod schemas for WhatsApp Cloud API webhooks (incl. Coexistence).
 *
 * Shapes are reconstructed from type definitions and fixtures shipped in maintained open-source SDKs plus
 * secondary documentation (Meta's own pages were unreachable when this was written; see DECISIONS.md D-031).
 * Everything is `looseObject`: unknown extra fields are kept, never rejected, so a Meta addition cannot break ingest.
 * A value that does not match is parked as an `other` event and raises an alert instead of being dropped.
 */

const text = z.string();
/** Meta sends epoch seconds as a string; tolerate a number too. */
const timestamp = z.union([z.string(), z.number()]).transform((value) => String(value));

export const metadataSchema = z.looseObject({
  display_phone_number: text.optional(),
  phone_number_id: text.optional(),
});

export const webhookErrorSchema = z.looseObject({
  code: z.number().optional(),
  title: text.optional(),
  message: text.optional(),
  error_data: z.looseObject({ details: text.optional() }).optional(),
});

export const contactSchema = z.looseObject({
  wa_id: text.optional(),
  /** Business-scoped user id: present on every contacts[] entry of a messages webhook. */
  user_id: text.optional(),
  parent_user_id: text.optional(),
  profile: z.looseObject({ name: text.optional(), username: text.optional() }).optional(),
  /** smb_app_state_sync: the contact was removed in the Business app. */
  removed: z.boolean().optional(),
});

const mediaSchema = z.looseObject({
  id: text.optional(),
  mime_type: text.optional(),
  sha256: text.optional(),
  caption: text.optional(),
  filename: text.optional(),
  voice: z.boolean().optional(),
  animated: z.boolean().optional(),
  url: text.optional(),
});

export const messageSchema = z.looseObject({
  id: text,
  /** Phone-based sender. May be absent for username users: use from_user_id. */
  from: text.optional(),
  from_user_id: text.optional(),
  from_parent_user_id: text.optional(),
  /** Present on smb_message_echoes: the customer the business app wrote to. */
  to: text.optional(),
  to_user_id: text.optional(),
  recipient_id: text.optional(),
  recipient_user_id: text.optional(),
  group_id: text.optional(),
  timestamp: timestamp.optional(),
  type: text.optional(),
  context: z
    .looseObject({ id: text.optional(), from: text.optional(), forwarded: z.boolean().optional() })
    .optional(),
  edited: z.boolean().optional(),
  revoked: z.boolean().optional(),
  errors: z.array(webhookErrorSchema).optional(),
  text: z.looseObject({ body: text.optional() }).optional(),
  image: mediaSchema.optional(),
  video: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  document: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  location: z
    .looseObject({ latitude: z.number().optional(), longitude: z.number().optional(), name: text.optional(), address: text.optional() })
    .optional(),
  contacts: z.array(z.unknown()).optional(),
  interactive: z
    .looseObject({
      type: text.optional(),
      button_reply: z.looseObject({ id: text.optional(), title: text.optional() }).optional(),
      list_reply: z.looseObject({ id: text.optional(), title: text.optional(), description: text.optional() }).optional(),
      nfm_reply: z.looseObject({ name: text.optional(), body: text.optional(), response_json: text.optional() }).optional(),
    })
    .optional(),
  button: z.looseObject({ payload: text.optional(), text: text.optional() }).optional(),
  order: z
    .looseObject({
      catalog_id: text.optional(),
      text: text.optional(),
      product_items: z.array(z.looseObject({ product_retailer_id: text.optional(), quantity: z.number().optional() })).optional(),
    })
    .optional(),
  reaction: z.looseObject({ message_id: text.optional(), emoji: text.optional() }).optional(),
  system: z
    .looseObject({
      body: text.optional(),
      type: text.optional(),
      wa_id: text.optional(),
      user_id: text.optional(),
      parent_user_id: text.optional(),
      previous_user_id: text.optional(),
    })
    .optional(),
  unsupported: z.looseObject({ type: text.optional() }).optional(),
  /** History sync: delivery state of an owner-side message. */
  history_context: z.looseObject({ status: text.optional() }).optional(),
});

export const statusSchema = z.looseObject({
  id: text,
  status: text,
  timestamp: timestamp.optional(),
  recipient_id: text.optional(),
  recipient_user_id: text.optional(),
  recipient_parent_user_id: text.optional(),
  /** Echo of what we sent in biz_opaque_callback_data (our message id): matches a status that beats our wamid write. */
  biz_opaque_callback_data: text.optional(),
  errors: z.array(webhookErrorSchema).optional(),
  conversation: z.looseObject({ id: text.optional() }).optional(),
  pricing: z.unknown().optional(),
});

const historyThreadSchema = z.looseObject({
  /** The customer's wa_id (or BSUID) this thread belongs to. */
  id: text.optional(),
  messages: z.array(messageSchema).default([]),
});

export const historyChunkSchema = z.looseObject({
  phase: z.number().optional(),
  window: text.optional(),
  /** An object in some payloads, a number in others. */
  progress: z.unknown().optional(),
  metadata: z.looseObject({ phase: z.number().optional(), chunk_order: z.number().optional(), progress: z.unknown().optional() }).optional(),
  excluded: z.looseObject({ group_chats: z.boolean().optional() }).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
  threads: z.array(historyThreadSchema).optional(),
});

// ---- webhook field values (what lives in entry[].changes[].value) -----------------------------------------------

export const messagesFieldValueSchema = z.looseObject({
  metadata: metadataSchema.optional(),
  contacts: z.array(contactSchema).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(statusSchema).optional(),
  errors: z.array(webhookErrorSchema).optional(),
});

/** Official shape uses `message_echoes[]` (with `to`); open-source fixtures use `messages[]`. Both are accepted. */
export const echoFieldValueSchema = z.looseObject({
  metadata: metadataSchema.optional(),
  message_echoes: z.array(messageSchema).optional(),
  messages: z.array(messageSchema).optional(),
});

export const historyFieldValueSchema = z.looseObject({
  metadata: metadataSchema.optional(),
  request_id: text.optional(),
  errors: z.array(webhookErrorSchema).optional(),
  history: z.array(historyChunkSchema).optional(),
});

export const appStateFieldValueSchema = z.looseObject({
  metadata: metadataSchema.optional(),
  request_id: text.optional(),
  contacts: z.array(contactSchema).optional(),
  errors: z.array(webhookErrorSchema).optional(),
});

const idChangeSchema = z.looseObject({ previous: text, current: text });

export const userIdUpdateEntrySchema = z.looseObject({
  wa_id: text.optional(),
  detail: text.optional(),
  user_id: idChangeSchema,
  parent_user_id: idChangeSchema.optional(),
  timestamp: timestamp.optional(),
});

export const userIdUpdateFieldValueSchema = z.looseObject({
  metadata: metadataSchema.optional(),
  contacts: z.array(contactSchema).optional(),
  user_id_update: z.array(userIdUpdateEntrySchema),
});

export const userPreferenceEntrySchema = z.looseObject({
  wa_id: text.optional(),
  user_id: text.optional(),
  detail: text.optional(),
  category: text.optional(),
  value: text.optional(),
  timestamp: timestamp.optional(),
});

export const userPreferencesFieldValueSchema = z.looseObject({
  metadata: metadataSchema.optional(),
  user_preferences: z.array(userPreferenceEntrySchema),
});

// ---- envelope --------------------------------------------------------------------------------------------------

export const envelopeSchema = z.looseObject({
  object: text,
  entry: z.array(
    z.looseObject({
      id: text.optional(),
      time: z.number().optional(),
      changes: z.array(z.looseObject({ field: text, value: z.unknown() })).default([]),
    }),
  ),
});

export type Envelope = z.infer<typeof envelopeSchema>;
export type WebhookMessage = z.infer<typeof messageSchema>;
export type WebhookStatus = z.infer<typeof statusSchema>;
export type WebhookContact = z.infer<typeof contactSchema>;
export type WebhookMetadata = z.infer<typeof metadataSchema>;
export type WebhookError = z.infer<typeof webhookErrorSchema>;
export type HistoryChunk = z.infer<typeof historyChunkSchema>;
export type UserIdUpdateEntry = z.infer<typeof userIdUpdateEntrySchema>;
export type UserPreferenceEntry = z.infer<typeof userPreferenceEntrySchema>;

export type EnvelopeParse =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: 'not_json_object' | 'wrong_object' | 'invalid_shape'; object?: string };

export const WHATSAPP_OBJECT = 'whatsapp_business_account';

/**
 * Validates the outer envelope only. Distinguishes "not a WhatsApp payload" (ignored with 200) from
 * "a WhatsApp payload we cannot parse" (stored and alerted, also 200).
 */
export function parseEnvelope(json: unknown): EnvelopeParse {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, reason: 'not_json_object' };
  const object = (json as Record<string, unknown>).object;
  if (object !== WHATSAPP_OBJECT) {
    return { ok: false, reason: 'wrong_object', ...(typeof object === 'string' ? { object } : {}) };
  }
  const parsed = envelopeSchema.safeParse(json);
  return parsed.success ? { ok: true, envelope: parsed.data } : { ok: false, reason: 'invalid_shape' };
}

// ---- stored items (what the webhook route persists and the processor re-validates) ------------------------------

const itemBase = { metadata: metadataSchema.optional() };

export const messageItemSchema = z.looseObject({
  field: z.literal('messages'),
  ...itemBase,
  contacts: z.array(contactSchema).optional(),
  message: messageSchema,
});

export const statusItemSchema = z.looseObject({
  field: z.literal('messages'),
  ...itemBase,
  contacts: z.array(contactSchema).optional(),
  status: statusSchema,
});

export const echoItemSchema = z.looseObject({
  field: z.literal('smb_message_echoes'),
  ...itemBase,
  message: messageSchema,
});

export const historyItemSchema = z.looseObject({
  field: z.literal('history'),
  ...itemBase,
  request_id: text.optional(),
  chunk: historyChunkSchema.optional(),
  errors: z.array(webhookErrorSchema).optional(),
});

export const appStateItemSchema = z.looseObject({
  field: z.literal('smb_app_state_sync'),
  ...itemBase,
  request_id: text.optional(),
  contact: contactSchema.optional(),
  errors: z.array(webhookErrorSchema).optional(),
});

export const userIdUpdateItemSchema = z.looseObject({
  field: z.literal('user_id_update'),
  ...itemBase,
  update: userIdUpdateEntrySchema,
});

export const userPreferenceItemSchema = z.looseObject({
  field: z.literal('user_preferences'),
  ...itemBase,
  preference: userPreferenceEntrySchema,
});

/** Account lifecycle and anything unrecognised: kept verbatim. */
export const otherItemSchema = z.looseObject({
  field: text,
  value: z.unknown(),
  parseError: z.boolean().optional(),
});

export type MessageItem = z.infer<typeof messageItemSchema>;
export type StatusItem = z.infer<typeof statusItemSchema>;
export type EchoItem = z.infer<typeof echoItemSchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type AppStateItem = z.infer<typeof appStateItemSchema>;
export type UserIdUpdateItem = z.infer<typeof userIdUpdateItemSchema>;
export type UserPreferenceItem = z.infer<typeof userPreferenceItemSchema>;
export type OtherItem = z.infer<typeof otherItemSchema>;
