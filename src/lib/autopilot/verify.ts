import 'server-only';
import { loadDraftContext, reasoningFor } from '@/lib/ai/draft';
import { chatModelId } from '@/lib/ai/models';
import { VERIFY_PROMPT_VERSION, verifyInstructions, verifyUserPrompt } from '@/lib/ai/prompts/verify';
import { runStructured } from '@/lib/ai/run';
import { type VerifyOutput, verifyOutputSchema } from '@/lib/ai/schemas';
import type { Db } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Asks the independent verifier (spec 9.7) about a finished draft. Never throws: ANY failure (the provider is down, the answer is not the
 * schema, the call times out) is `'error'`, and the policy treats an error as a failure, so a broken verifier can only ever send drafts
 * to the owner, never past a check that did not run.
 */
export interface VerifyRequest {
  conversationId: string;
  /** The customer messages the draft answers. */
  burstMessageIds: readonly string[];
  /** The text that would be sent. */
  reply: string;
  draftId: string;
  now: Date;
}

export const VERIFY_TIMEOUT_MS = 30_000;

export async function verifyReply(db: Db, request: VerifyRequest): Promise<VerifyOutput | 'error'> {
  try {
    // Context only: the profile, the conversation and the new messages. The few-shot examples and style guide it also loads are NOT passed on.
    const { context } = await loadDraftContext(db, { conversationId: request.conversationId, burstMessageIds: request.burstMessageIds, now: request.now, useSummary: false });
    const modelId = chatModelId('verify');
    const verifyContext = {
      ownerName: context.ownerName,
      businessName: context.businessName,
      ownerTimezone: context.ownerTimezone,
      now: request.now,
      businessProfile: context.businessProfile,
      history: context.history,
      burst: context.burst,
      reply: request.reply,
    };
    const reasoning = reasoningFor(modelId);
    const { output } = await runStructured({
      purpose: 'verify',
      modelId,
      promptVersion: VERIFY_PROMPT_VERSION,
      schema: verifyOutputSchema,
      instructions: verifyInstructions(verifyContext),
      prompt: verifyUserPrompt(verifyContext),
      draftId: request.draftId,
      timeoutMs: VERIFY_TIMEOUT_MS,
      temperature: 0,
      ...(reasoning ? { reasoning } : {}),
      db,
    });
    return output;
  } catch (error) {
    // The error NAME only: what the model or the customer wrote never goes in a log.
    logger.warn({ error: error instanceof Error ? error.name : 'unknown', draftId: request.draftId }, 'autopilot verifier failed');
    return 'error';
  }
}
