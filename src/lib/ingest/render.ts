import type { contentSource, messageType } from '@/lib/db/schema';
import type { WebhookMessage } from '@/lib/whatsapp/webhook-schema';

export type StoredMessageType = (typeof messageType.enumValues)[number];
export type StoredContentSource = (typeof contentSource.enumValues)[number];

export interface MappedMessage {
  type: StoredMessageType;
  /** What the owner and the AI read. Placeholders such as `[Image]` are explicit, never silent. */
  content: string | null;
  contentSource: StoredContentSource | null;
  mediaId: string | null;
  mediaMime: string | null;
  /** `pending` when a machine transcript will be produced for this voice note. */
  transcription: 'pending' | null;
  /** For a reaction: the wamid of the message reacted to. */
  reactionTarget: string | null;
}

export interface MapOptions {
  /** TRANSCRIBE_AUDIO. Only inbound customer audio is ever transcribed. */
  transcribeAudio: boolean;
  /** Owner-side and history messages are not transcribed. */
  transcribable: boolean;
}

const MEDIA_LABEL = {
  image: 'Image',
  video: 'Video',
  document: 'Document',
  sticker: 'Sticker',
} as const;

const clean = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** A type string we have never seen is shown, but only as a safe token: it came from outside. */
function safeToken(value: string | undefined): string {
  return (value ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
}

function contactNames(contacts: readonly unknown[] | undefined): string[] {
  const names: string[] = [];
  for (const entry of contacts ?? []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== 'object' || name === null) continue;
    const formatted = (name as { formatted_name?: unknown }).formatted_name;
    if (typeof formatted === 'string' && formatted.trim()) names.push(formatted.trim().slice(0, 80));
  }
  return names;
}

const base: MappedMessage = {
  type: 'unsupported',
  content: null,
  contentSource: null,
  mediaId: null,
  mediaMime: null,
  transcription: null,
  reactionTarget: null,
};

function rendered(type: StoredMessageType, content: string, extra: Partial<MappedMessage> = {}): MappedMessage {
  return { ...base, type, content, contentSource: 'rendered', ...extra };
}

function mapMedia(message: WebhookMessage, kind: keyof typeof MEDIA_LABEL): MappedMessage {
  const media = message[kind];
  const id = clean(media?.id);
  const caption = clean(media?.caption);
  const mediaFields = { mediaId: id, mediaMime: clean(media?.mime_type) };
  if (caption !== null) return { ...base, type: kind, content: caption, contentSource: 'caption', ...mediaFields };

  const label = MEDIA_LABEL[kind];
  const filename = kind === 'document' ? clean(media?.filename) : null;
  const named = filename === null ? label : `${label}: ${filename.slice(0, 120)}`;
  // History past the media retention window arrives without an id: say so instead of pretending there is a file.
  return rendered(kind, id === null ? `[${label} unavailable]` : `[${named}]`, mediaFields);
}

function mapAudio(message: WebhookMessage, options: MapOptions): MappedMessage {
  const audio = message.audio;
  const id = clean(audio?.id);
  const label = audio?.voice === false ? 'Audio' : 'Voice message';
  return rendered('audio', id === null ? `[${label} unavailable]` : `[${label}]`, {
    mediaId: id,
    mediaMime: clean(audio?.mime_type),
    // The placeholder is replaced by the transcript once the media worker produces one.
    transcription: options.transcribeAudio && options.transcribable && id !== null ? 'pending' : null,
  });
}

function mapInteractive(message: WebhookMessage): MappedMessage {
  const interactive = message.interactive;
  const button = clean(interactive?.button_reply?.title);
  if (button !== null) return { ...base, type: 'interactive', content: button, contentSource: 'text' };
  const list = clean(interactive?.list_reply?.title);
  if (list !== null) {
    const description = clean(interactive?.list_reply?.description);
    return { ...base, type: 'interactive', content: description === null ? list : `${list} - ${description}`, contentSource: 'text' };
  }
  const form = clean(interactive?.nfm_reply?.name);
  return rendered('interactive', form === null ? '[Interactive reply]' : `[Form response: ${form.slice(0, 80)}]`);
}

/**
 * Maps a WhatsApp message to our stored shape. Pure. Every type we know gets a readable rendering, and every type we do
 * not know becomes `unsupported` with a safe placeholder: ingest never throws on a message it cannot understand.
 * `system` messages are not chat messages and are handled by the identity code before this is called.
 */
export function mapMessage(message: WebhookMessage, options: MapOptions): MappedMessage {
  switch (message.type) {
    case 'text': {
      const body = message.text?.body;
      return body === undefined ? { ...base, type: 'text' } : { ...base, type: 'text', content: body, contentSource: 'text' };
    }
    case 'image':
    case 'video':
    case 'document':
    case 'sticker':
      return mapMedia(message, message.type);
    case 'audio':
      return mapAudio(message, options);
    case 'location': {
      const { name, address, latitude, longitude } = message.location ?? {};
      const where = [clean(name), clean(address)].filter((part): part is string => part !== null).join(', ');
      const coords = latitude !== undefined && longitude !== undefined ? `${latitude}, ${longitude}` : null;
      const detail = [where === '' ? null : where, coords === null ? null : `(${coords})`].filter((part) => part !== null).join(' ');
      return rendered('location', detail === '' ? '[Location]' : `[Location: ${detail}]`);
    }
    case 'contacts': {
      const names = contactNames(message.contacts);
      return rendered('contacts', names.length === 0 ? '[Shared contact]' : `[Shared contact: ${names.join(', ')}]`);
    }
    case 'interactive':
      return mapInteractive(message);
    case 'button': {
      const label = clean(message.button?.text) ?? clean(message.button?.payload);
      return label === null ? rendered('button', '[Button reply]') : { ...base, type: 'button', content: label, contentSource: 'text' };
    }
    case 'order': {
      const count = message.order?.product_items?.reduce((sum, item) => sum + (item.quantity ?? 1), 0) ?? 0;
      const note = clean(message.order?.text);
      const head = count > 0 ? `[Order: ${count} item${count === 1 ? '' : 's'}]` : '[Order]';
      return rendered('interactive', note === null ? head : `${head} ${note}`);
    }
    case 'reaction':
      // An empty emoji is the customer removing their reaction.
      return { ...base, type: 'reaction', content: message.reaction?.emoji ?? '', contentSource: 'text', reactionTarget: clean(message.reaction?.message_id) };
    case 'unsupported':
      return rendered('unsupported', '[Unsupported message]');
    default: {
      // A missing `type` with a text body still reads as text; anything else is a type from the future.
      if (message.type === undefined && message.text?.body !== undefined) {
        return { ...base, type: 'text', content: message.text.body, contentSource: 'text' };
      }
      const token = safeToken(message.type);
      return rendered('unsupported', token === '' ? '[Unsupported message]' : `[Unsupported message type: ${token}]`);
    }
  }
}

/** Meta timestamps are epoch SECONDS as strings. Returns null when missing or not a sane number. */
export function parseTimestamp(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Tolerance before a timestamp from "the future" is treated as clock skew and clamped to now. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * When a message happened. A missing timestamp becomes `now`; one more than five minutes in the future is clamped to
 * `now` too, because the 24h window is computed from it and a wrong clock must never extend the right to send free text.
 */
export function occurredAtOf(message: WebhookMessage, now: Date): Date {
  const parsed = parseTimestamp(message.timestamp);
  if (parsed === null) return now;
  return parsed.getTime() > now.getTime() + FUTURE_TOLERANCE_MS ? now : parsed;
}
