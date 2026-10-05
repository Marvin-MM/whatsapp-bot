import 'server-only';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { getProducerConnection } from '@/lib/queue/connection';

/**
 * Where a style extraction stands, for the /style page ("running", "done", "failed: why"). It is a status, not business data, so it
 * lives in Redis: the extraction's RESULT is the new style_guides row. A "running" entry expires on its own so a crashed worker can
 * never leave the button disabled forever.
 */

const TTL_SECONDS = 60 * 60;
/** A running status older than this is treated as dead. */
export const RUNNING_STALE_MS = 10 * 60 * 1000;

export const styleStatusSchema = z.object({
  state: z.enum(['running', 'done', 'failed']),
  at: z.iso.datetime(),
  version: z.number().int().optional(),
  message: z.string().max(300).optional(),
});
export type StyleExtractionStatus = z.infer<typeof styleStatusSchema>;

const key = () => `${getEnv().BULLMQ_PREFIX}:style-extract`;

export async function writeStyleStatus(status: Omit<StyleExtractionStatus, 'at'> & { at?: Date }): Promise<void> {
  const value: StyleExtractionStatus = { ...status, at: (status.at ?? new Date()).toISOString() };
  await getProducerConnection().set(key(), JSON.stringify(value), 'EX', TTL_SECONDS);
}

export async function readStyleStatus(): Promise<StyleExtractionStatus | null> {
  try {
    const raw = await getProducerConnection().get(key());
    if (raw === null) return null;
    const parsed = styleStatusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isRunning(status: StyleExtractionStatus | null, now: Date = new Date()): boolean {
  return status?.state === 'running' && now.getTime() - new Date(status.at).getTime() < RUNNING_STALE_MS;
}
