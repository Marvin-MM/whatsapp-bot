import 'server-only';
import { z } from 'zod';
import { type AuditEntry, writeAudit } from '@/lib/audit';
import { type OwnerSession, checkOwner } from '@/lib/auth-guard';
import { type Tx, getDb } from '@/lib/db';
import { logger } from '@/lib/logger';

export interface ActionError {
  /** `refused`: the action understood the request and deliberately did not do it (a send pre-check failed): `reason` says why. */
  code: 'unauthorized' | 'invalid_input' | 'refused' | 'failed';
  message: string;
  fieldErrors?: Record<string, string[]>;
  reason?: string;
}

/**
 * Thrown inside a handler to REFUSE the request. The transaction rolls back (nothing is written, not even the audit entry),
 * and the caller gets `{ ok: false, error: { code: 'refused', reason, message } }` with a message the owner can act on.
 */
export class ActionRefusal extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ActionRefusal';
  }
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
  handler: (ctx: { input: z.output<S>; owner: OwnerSession; tx: Tx }) => Promise<{
    data: R;
    audit: Omit<AuditEntry, 'actor'>;
    /**
     * Runs only AFTER the transaction has committed (enqueue a job, publish an event). It never runs on a rollback, and if it
     * throws the action still succeeds: the change is already committed, so the failure is logged and a safety net (for sends:
     * the alerts-scan re-enqueue) picks it up rather than telling the owner "failed" about something that happened.
     */
    afterCommit?: () => Promise<void>;
  }>;
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

      let afterCommit: (() => Promise<void>) | undefined;
      let data: R;
      try {
        data = await getDb().transaction(async (tx) => {
          const result = await config.handler({ input: parsed.data, owner: check.owner, tx });
          await writeAudit(tx, { actor: 'owner', ...result.audit });
          afterCommit = result.afterCommit;
          return result.data;
        });
      } catch (error) {
        if (error instanceof ActionRefusal) {
          return { ok: false, error: { code: 'refused', reason: error.reason, message: error.message } };
        }
        // Never leak internals (or message bodies) to the client; the log has the error name only.
        logger.error({ action: config.name, error: error instanceof Error ? error.name : 'unknown' }, 'owner action failed');
        return { ok: false, error: { code: 'failed', message: 'Something went wrong. Nothing was changed.' } };
      }

      if (afterCommit) {
        try {
          await afterCommit();
        } catch (error) {
          logger.error({ action: config.name, error: error instanceof Error ? error.name : 'unknown' }, 'after-commit hook failed');
        }
      }
      return { ok: true, data };
    };
  };
}

export interface OwnerQueryConfig<S extends z.ZodType, R> {
  /** Stable name for logs, e.g. `templates.list`. */
  name: string;
  schema: S;
  /** Read-only work (it may call out to Meta or Redis: there is no transaction to hold). Throw `ActionRefusal` to say "no, and why". */
  handler: (ctx: { input: z.output<S>; owner: OwnerSession }) => Promise<R>;
}

/**
 * The read-only sibling of `ownerAction`: a server action that changes nothing in the database, so there is no audit entry and
 * no transaction, but the same order of events (authenticate, then validate, then run) and the same never-throws contract.
 */
export function createOwnerQuery(getHeaders: () => Promise<Headers>) {
  return function ownerQuery<S extends z.ZodType, R>(config: OwnerQueryConfig<S, R>) {
    return async (rawInput: unknown): Promise<ActionResult<R>> => {
      const check = await checkOwner(await getHeaders());
      if (!check.ok) {
        logger.warn({ action: config.name, reason: check.reason }, 'owner query rejected');
        return UNAUTHORIZED;
      }
      const parsed = config.schema.safeParse(rawInput);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: 'invalid_input', message: 'The submitted data is not valid.', fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> },
        };
      }
      try {
        return { ok: true, data: await config.handler({ input: parsed.data, owner: check.owner }) };
      } catch (error) {
        if (error instanceof ActionRefusal) return { ok: false, error: { code: 'refused', reason: error.reason, message: error.message } };
        logger.error({ action: config.name, error: error instanceof Error ? error.name : 'unknown' }, 'owner query failed');
        return { ok: false, error: { code: 'failed', message: 'Something went wrong.' } };
      }
    };
  };
}
