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

/**
 * What the post-send analysis returns (spec 9.5): the rolling summary and the changes to the conversation's tasks. Code, not the model,
 * decides which operations are acceptable (`lib/analysis/operations.ts`): ids outside the conversation, tasks that are not open and due
 * dates long in the past are rejected.
 */
export const TASK_TYPES = ['request', 'followup', 'reminder'] as const;

export const analysisOutputSchema = z.object({
  /** At most three sentences about the WHOLE conversation so far. */
  summary: z.string().max(500),
  operations: z
    .array(
      z.discriminatedUnion('op', [
        z.object({ op: z.literal('create'), description: z.string().min(1).max(200), type: z.enum(TASK_TYPES), dueAt: z.iso.datetime({ offset: true }).nullable() }),
        z.object({ op: z.literal('complete'), taskId: z.uuid() }),
        z.object({ op: z.literal('update'), taskId: z.uuid(), description: z.string().min(1).max(200).optional(), dueAt: z.iso.datetime({ offset: true }).nullable().optional() }),
      ]),
    )
    .max(10),
});

export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;
export type AnalysisOperation = AnalysisOutput['operations'][number];

/**
 * What the autopilot verifier returns (spec 9.7). `verdict` comes last: the model lists what is wrong before it decides. Code does not trust
 * `verdict` alone (`verifierPasses` in `autopilot/policy.ts` also needs both lists empty, `answersTheCustomer` and no tone risk).
 */
export const verifyOutputSchema = z.object({
  unsupportedClaims: z.array(z.string().max(200)).max(20),
  commitments: z.array(z.string().max(200)).max(20),
  answersTheCustomer: z.boolean(),
  toneRisk: z.boolean(),
  verdict: z.enum(['pass', 'fail']),
});

export type VerifyOutput = z.infer<typeof verifyOutputSchema>;
