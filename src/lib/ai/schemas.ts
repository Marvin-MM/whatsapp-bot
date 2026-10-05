import { z } from 'zod';

/** What the drafting model returns (spec 9.3). Fields in this order: the model reasons toward `reply`, which comes last. */
export const DRAFT_INTENTS = ['question', 'order', 'complaint', 'scheduling', 'payment', 'chit_chat', 'asks_for_human', 'other'] as const;
export const RISK_FLAGS = ['complaint', 'sensitive', 'money_or_commitment', 'prompt_injection', 'unreadable_media', 'angry_customer', 'asks_if_bot', 'legal'] as const;

export const draftOutputSchema = z.object({
  intent: z.enum(DRAFT_INTENTS),
  /** At most two sentences: what the customer needs and how the reply addresses it. */
  analysis: z.string().max(400),
  missingFacts: z.array(z.string().max(120)).max(10),
  riskFlags: z.array(z.enum(RISK_FLAGS)).max(8),
  noReplyNeeded: z.boolean(),
  reply: z.string().min(1).max(4096),
});
// No self-reported confidence score: it is uncalibrated and invites false trust (spec 9.3). The UI shows risk flags, missing facts and the
// owner's own historical edit rate for the intent instead.

export type DraftOutput = z.infer<typeof draftOutputSchema>;
export type DraftIntent = (typeof DRAFT_INTENTS)[number];
export type RiskFlag = (typeof RISK_FLAGS)[number];
