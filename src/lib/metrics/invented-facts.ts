/**
 * "Invented fact" detector for the evaluation (spec 9.8): numbers, amounts and calendar words in a draft that appear nowhere in what the
 * model was given, outside a `[[placeholder]]`. A placeholder is the model correctly saying "I do not know", so it is never a finding.
 *
 * What counts as "what the model was given" is decided by the caller: the business profile, the conversation (summary, history, the new
 * messages), and the clock line. NOT the few-shot examples: a price from some other customer's chat must not license a price here.
 *
 * Known blind spots, by design (a regex cannot read): numbers written as words ("fifty thousand"), a wrong NAME or product, a wrong
 * place, and relative dates ("tomorrow"). It errs toward flagging: a stray "2" the customer did not mention is reported.
 */

const PLACEHOLDER = /\[\[[^\]]*\]\]/g;
const LIST_MARKER = /^\s*\d{1,2}[.)]\s/gm;

const MONTHS = ['january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const CALENDAR_WORD = new RegExp(`\\b(${[...MONTHS, ...WEEKDAYS].join('|')})\\b`, 'gi');

// "50,000", "50 000" (groups of exactly three), or plain "2500" / "2.5", optionally followed directly by k / m ("50k").
const NUMBER = /(\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?([kKmM])(?![A-Za-z]))?/g;

function canonical(raw: string, suffix: string | undefined): string {
  let value = Number(raw.replace(/[, ]/g, ''));
  if (suffix) value *= suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return String(Number.isFinite(value) ? value : raw);
}

/** Every fact-like token in a text: canonical numbers (`50k`, `UGX 50,000` and `50000` are all `50000`) and calendar words. */
export function factTokens(text: string): Set<string> {
  const cleaned = text.replace(PLACEHOLDER, ' ').replace(LIST_MARKER, ' ');
  const tokens = new Set<string>();
  for (const match of cleaned.matchAll(NUMBER)) tokens.add(canonical(match[1] ?? '', match[2]));
  for (const match of cleaned.matchAll(CALENDAR_WORD)) tokens.add(match[1]?.toLowerCase() ?? '');
  return tokens;
}

/** Fact-like tokens in `reply` that appear in none of `allowedTexts`. Empty means no invented facts were found. */
export function inventedFacts(reply: string, allowedTexts: readonly string[]): string[] {
  const allowed = new Set<string>();
  for (const text of allowedTexts) for (const token of factTokens(text)) allowed.add(token);
  return [...factTokens(reply)].filter((token) => !allowed.has(token)).sort();
}
