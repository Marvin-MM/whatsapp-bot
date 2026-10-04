import 'server-only';
import { z } from 'zod';
import { type AuditEntry, writeAudit } from '@/lib/audit';
import { type OwnerSession, checkOwner } from '@/lib/auth-guard';
import { type Tx, getDb } from '@/lib/db';
import { logger } from '@/lib/logger';

export interface ActionError {
  code: 'unauthorized' | 'invalid_input' | 'failed';
  message: string;
  fieldErrors?: Record<string, string[]>;
}

/** Every server action returns this; it never throws to the client. */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

export interface OwnerActionConfig<S extends z.ZodType, R> {
  /** Stable name for logs, e.g. `settings.setKillSwitch`. */
  name: string;
  schema: S;
  /**
   * Runs inside one transaction with the audit write: a thrown error rolls back both.
   * Must return the audit entry for the mutation (read-only queries do not use this wrapper).
   */
  handler: (ctx: { input: z.output<S>; owner: OwnerSession; tx: Tx }) => Promise<{ data: R; audit: Omit<AuditEntry, 'actor'> }>;
}

const UNAUTHORIZED: ActionResult<never> = {
  ok: false,
  error: { code: 'unauthorized', message: 'You must be signed in as the owner.' },
};

/**
 * Builds the `ownerAction` factory for a given way of getting request headers
 * (Next's `headers()` in production, a fake in tests).
 *
 * Order matters: authenticate first so unauthenticated callers learn nothing about input shapes,
 * then validate with Zod, then run handler + audit atomically.
 */
export function createOwnerAction(getHeaders: () => Promise<Headers>) {
  return function ownerAction<S extends z.ZodType, R>(config: OwnerActionConfig<S, R>) {
    return async (rawInput: unknown): Promise<ActionResult<R>> => {
      const check = await checkOwner(await getHeaders());
      if (!check.ok) {
        logger.warn({ action: config.name, reason: check.reason }, 'owner action rejected');
        return UNAUTHORIZED;
      }

      const parsed = config.schema.safeParse(rawInput);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'The submitted data is not valid.',
            fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
          },
        };
      }

      try {
        const data = await getDb().transaction(async (tx) => {
          const result = await config.handler({ input: parsed.data, owner: check.owner, tx });
          await writeAudit(tx, { actor: 'owner', ...result.audit });
          return result.data;
        });
        return { ok: true, data };
      } catch (error) {
        // Never leak internals (or message bodies) to the client; the log has the error name only.
        logger.error({ action: config.name, error: error instanceof Error ? error.name : 'unknown' }, 'owner action failed');
        return { ok: false, error: { code: 'failed', message: 'Something went wrong. Nothing was changed.' } };
      }
    };
  };
}
