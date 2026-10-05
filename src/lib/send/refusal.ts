import 'server-only';
import { ActionRefusal } from '@/lib/actions/owner-action-core';
import { SendRefused } from './send-message';

/** Runs a send-path call inside an owner action: a pre-check refusal becomes an `ActionRefusal` (rollback + a sentence the owner can act on). */
export async function refusingOnSendRefused<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SendRefused) throw new ActionRefusal(error.code, error.message);
    throw error;
  }
}
