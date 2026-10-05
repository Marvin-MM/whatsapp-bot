import { PLACEHOLDER_PATTERN } from '@/lib/send/precheck';

/** Pure wording and parsing for the approvals screen, kept out of the components so it is testable without rendering. */

export const INTENT_LABEL: Record<string, string> = {
  question: 'Question',
  order: 'Order',
  complaint: 'Complaint',
  scheduling: 'Scheduling',
  payment: 'Payment',
  chit_chat: 'Chit-chat',
  asks_for_human: 'Asks for a person',
  other: 'Other',
};

/** Intents the owner should read twice: the chip turns red/amber instead of grey. */
export const INTENT_TONE: Record<string, 'neutral' | 'warning' | 'danger'> = { complaint: 'danger', asks_for_human: 'warning', payment: 'warning' };

export const RISK_FLAG_LABEL: Record<string, string> = {
  complaint: 'The customer is complaining',
  sensitive: 'Sensitive topic',
  money_or_commitment: 'Money or a promise is involved',
  prompt_injection: 'The message tries to give the assistant instructions',
  unreadable_media: 'A voice note or file could not be read reliably',
  angry_customer: 'The customer sounds angry',
  asks_if_bot: 'The customer asks whether they are talking to a person',
  legal: 'Legal matter',
  missing_facts_unmarked: 'A fact is missing but the draft does not mark it: check every number and name',
};

export const intentLabel = (intent: string): string => INTENT_LABEL[intent] ?? intent;
export const intentTone = (intent: string): 'neutral' | 'warning' | 'danger' => INTENT_TONE[intent] ?? 'neutral';
export const riskFlagLabel = (flag: string): string => RISK_FLAG_LABEL[flag] ?? flag.replaceAll('_', ' ');

export interface PlaceholderMatch {
  /** The whole `[[...]]` as written, brackets included. */
  text: string;
  start: number;
  end: number;
}

/** Every `[[placeholder]]` in the text, in order. The same pattern the send pre-check refuses on, so "no matches" means "will not be blocked by it". */
export function findPlaceholders(text: string): PlaceholderMatch[] {
  const matches: PlaceholderMatch[] = [];
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined) matches.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

/** Whether what is in the box differs from what the model wrote, exactly as the server decides provenance (trimmed comparison). */
export const isEdited = (original: string, current: string): boolean => original.trim() !== current.trim();

export interface EditRate {
  sent: number;
  edited: number;
  medianEditDistance: number | null;
}

/** Fewer than this many sent drafts says nothing: show the count, not a percentage that looks like evidence. */
export const MIN_SAMPLE_FOR_RATE = 5;

/**
 * "How often I change this kind of draft": the honest stand-in for a model's confidence (spec 9.3). Plain words, never a score.
 */
export function describeEditRate(stats: EditRate, intent: string): string {
  const label = intentLabel(intent).toLowerCase();
  if (stats.sent === 0) return `You have not sent any “${label}” drafts yet in the last 90 days, so there is no history to compare with.`;
  if (stats.sent < MIN_SAMPLE_FOR_RATE) {
    return `You sent ${stats.sent} “${label}” draft${stats.sent === 1 ? '' : 's'} in the last 90 days (${stats.edited} edited): too few to say how often you change them.`;
  }
  const percent = Math.round((stats.edited / stats.sent) * 100);
  const typical = stats.medianEditDistance === null ? '' : `, and a typical edit changes about ${Math.round(stats.medianEditDistance * 100)}% of the text`;
  return `In the last 90 days you sent ${stats.sent} “${label}” drafts and edited ${stats.edited} of them (${percent}%)${typical}.`;
}
