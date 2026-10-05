'use server';

import { z } from 'zod';
import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { MIN_STYLE_MESSAGES, StyleActivationError, activateStyleGuide, countEligibleOwnerMessages } from '@/lib/ai/style';
import { isRunning, readStyleStatus, writeStyleStatus } from '@/lib/ai/style-status';
import { enqueue } from '@/lib/queue/enqueue';
import { ownerAction } from './owner-action';

const extract = ownerAction({
  name: 'style.requestExtraction',
  schema: z.object({}),
  handler: async ({ tx }) => {
    if (isRunning(await readStyleStatus())) throw new ActionRefusal('already_running', 'An extraction is already running. Wait for it to finish.');
    const eligible = await countEligibleOwnerMessages(tx);
    if (eligible < MIN_STYLE_MESSAGES) {
      throw new ActionRefusal('insufficient_data', `Only ${eligible} of your own messages are available to learn from; at least ${MIN_STYLE_MESSAGES} are needed. Import more chats first (pnpm import:chats).`);
    }
    return {
      data: { eligible },
      audit: { action: 'style.extract_requested', entityType: 'style_guide', entityId: 'new', metadata: { eligible } },
      afterCommit: async () => {
        await writeStyleStatus({ state: 'running' });
        await enqueue('style-extract', 'extract', { requestedAt: new Date().toISOString() }, { jobId: `style:${Date.now()}` });
      },
    };
  },
});

/** Starts a style extraction in the worker (a new, inactive version; the owner reads it and activates it). */
export async function requestStyleExtraction(input: unknown): Promise<ActionResult<{ eligible: number }>> {
  return extract(input);
}

const activate = ownerAction({
  name: 'style.activate',
  schema: z.object({ id: z.uuid() }),
  handler: async ({ input, tx }) => {
    try {
      const result = await activateStyleGuide(tx, input.id);
      return { data: result, audit: { action: 'style.activate', entityType: 'style_guide', entityId: input.id, metadata: { version: result.version, previousVersion: result.previousVersion } } };
    } catch (error) {
      if (error instanceof StyleActivationError) throw new ActionRefusal(error.code, error.message);
      throw error;
    }
  },
});

/** Makes one style version the active one (the previous one is deactivated in the same transaction). */
export async function activateStyleVersion(input: unknown): Promise<ActionResult<{ version: number; previousVersion: number | null }>> {
  return activate(input);
}
