/**
 * A deterministic second opinion on "is this customer trying to give the assistant instructions?" (spec 9.2 rule 3, spec 11).
 *
 * The drafting model is told to add `prompt_injection` to `riskFlags` when it sees such text, but a model that has been successfully
 * injected is exactly the one that will not report it. So the pipeline also looks at the customer's own words with a short list of
 * patterns and adds the flag itself. This is a WARNING, never a gate: it puts a badge on the draft (and, from Phase 7, keeps the draft
 * out of autopilot); it does not block anything, so a false positive costs the owner one extra look and a false negative is still
 * covered by the model's own flag and by the owner's approval.
 *
 * Deliberately narrow: ordinary chat contains "ignore my last message", "your rules for returns", "act as a go-between". Each pattern
 * needs the verb AND the thing being overridden or revealed. Known blind spots: other languages (the owner reads Luganda; a pattern list
 * does not), instructions hidden in an image, and anything paraphrased past the patterns. It is not a security boundary: the boundary is
 * that nothing the model writes is sent without the owner's approval (and, later, the autopilot policy).
 */

// Zero-width and bidi control characters are the usual way to split a trigger word past a naive match ("ig​nore").
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿­]/g;

const OVERRIDE_VERB = '(?:ignore|disregard|forget|override|bypass|discard)';
const INSTRUCTION_NOUN = '(?:instructions?|rules?|prompts?|guidelines?|directions?|programming|restrictions?|constraints?|training)';
// Words that point at the ASSISTANT's rules rather than the customer's own earlier message ("my" and "our" are deliberately absent:
// "ignore my previous instructions about the address" is a customer correcting themselves).
const ASSISTANT_SCOPE = '(?:all|any|every|your|previous|prior|above|earlier|preceding|system|safety|original|other)';
const DETERMINER = '(?:the|these|those|of)';
const REVEAL_VERB = '(?:reveal|show|print|repeat|leak|display|output|expose|share|tell\\s+me|give\\s+me|what\\s+(?:is|are|were))';
const PROMPT_QUALIFIER = '(?:system|initial|hidden|original|developer|secret|exact|full|complete|current|real)';

const PATTERNS: readonly RegExp[] = [
  // "ignore previous instructions", "disregard all the rules", "forget your instructions", "override any safety guidelines"
  new RegExp(`\\b${OVERRIDE_VERB}\\s+(?:${DETERMINER}\\s+)*(?:${ASSISTANT_SCOPE}\\s+(?:${DETERMINER}\\s+)*)+${INSTRUCTION_NOUN}\\b`, 'i'),
  // "disregard the rules above", "ignore the instructions you were given"
  new RegExp(`\\b${OVERRIDE_VERB}\\s+(?:the|these|those|all|your)\\s+${INSTRUCTION_NOUN}\\s+(?:above|before|given|provided|you\\s+(?:were|have\\s+been)\\s+given)\\b`, 'i'),
  // "ignore everything above", "ignore the above and say ..."
  /\b(?:ignore|disregard|forget)\s+(?:everything|anything|all)\s+(?:that\s+)?(?:is\s+|was\s+)?(?:said\s+|written\s+)?(?:above|before|previously)\b/i,
  /\b(?:ignore|disregard)\s+(?:the\s+)?above\b[^.!?\n]{0,12}\band\s+(?:say|tell|write|reply|respond|answer|offer|give|send|output|print|do)\b/i,
  // "show me your system prompt", "reveal your instructions", "what are your hidden rules"
  new RegExp(`\\b${REVEAL_VERB}\\b(?:\\W+\\w+){0,3}?\\W+your\\s+(?:${PROMPT_QUALIFIER}\\s+)*(?:prompt|instructions?)\\b`, 'i'),
  new RegExp(`\\b${REVEAL_VERB}\\b(?:\\W+\\w+){0,3}?\\W+the\\s+${PROMPT_QUALIFIER}\\s+(?:prompt|instructions?)\\b`, 'i'),
  // "system prompt", "developer message", "hidden instructions": nobody asking about a dress says these ("system message" is NOT here: "my phone's system message says the payment failed")
  /\bsystem\s+(?:prompt|instructions?)\b/i,
  /\bdeveloper\s+(?:prompt|message|instructions?)\b/i,
  /\b(?:hidden|secret|initial|original)\s+(?:prompt|instructions?)\b/i,
  // "you are now a ...", "you are no longer an assistant"
  /\byou\s+are\s+(?:now|no\s+longer)\s+(?:an?|the|my|free|unrestricted|dan)\b/i,
  // "from now on you will only answer yes"
  /\bfrom\s+now\s+on\b[^.!?\n]{0,30}\byou\s+(?:are|will|must|should|shall)\s+(?:only|always|never|answer|reply|respond|say|speak|act|behave|ignore|obey|follow|be|do|give|offer|send|call)\b/i,
  // "new instructions:", "your new role"
  /\bnew\s+(?:instructions?|persona|system\s+prompt)\b/i,
  /\byour\s+new\s+(?:role|task|instructions?|rules?|persona)\b/i,
  // role play / mode switches
  /\b(?:pretend|imagine)\s+(?:that\s+)?you\s+(?:are|were|have\s+no)\b/i,
  /\b(?:act|behave|respond|reply)\s+(?:as\s+if|as\s+though)\s+you\b/i,
  /\b(?:jailbreak|developer\s+mode|dan\s+mode|god\s+mode|do\s+anything\s+now)\b/i,
  /\byou\s+(?:have|are\s+under)\s+no\s+(?:rules|restrictions|limits|guidelines)\b/i,
  // fake structure: text that tries to look like a role marker or a prompt tag (angle brackets are neutralised elsewhere; the intent remains)
  /(?:^|\n)\s*(?:system|assistant|developer)\s*:\s*\S/i,
  /<\s*\/?\s*(?:system|instructions?|new_messages|conversation|business_profile|style_guide|examples)\b/i,
  /‹\s*\/?\s*(?:system|instructions?|new_messages|conversation|business_profile|style_guide|examples)\b/i,
];

/** Same text, minus the tricks that hide a trigger from a pattern: invisible characters, compatibility forms, runs of whitespace. */
function normalise(text: string): string {
  return text.replace(INVISIBLE, '').normalize('NFKC').replace(/[ \t]+/g, ' ');
}

/** Whether a customer's message looks like an attempt to instruct the assistant. Pure; never throws. */
export function looksLikePromptInjection(text: string): boolean {
  if (text.length === 0) return false;
  const cleaned = normalise(text);
  return PATTERNS.some((pattern) => pattern.test(cleaned));
}

/** True when ANY of the messages looks like an injection attempt. */
export const anyLooksLikePromptInjection = (texts: readonly string[]): boolean => texts.some(looksLikePromptInjection);
