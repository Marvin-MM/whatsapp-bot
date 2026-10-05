import { eq } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActionRefusal, createOwnerAction } from '@/lib/actions/owner-action-core';
import { getAuth } from '@/lib/auth';
import { checkOwner } from '@/lib/auth-guard';
import { getDb } from '@/lib/db';
import { user as userTable } from '@/lib/db/auth-schema';
import { auditLog, settings } from '@/lib/db/schema';
import { beginTotpEnrollment, cookieHeaderFromSetCookies, createOwnerUser, resetOwnerCredentials, signInOwner } from '@/lib/owner';
import { applyKillSwitch, killSwitchInputSchema } from '@/lib/settings/kill-switches';
import { secretFromOtpauthUri, totp } from '@/lib/totp';
import { OWNER_PASSWORD, createEnrolledOwner, headersWith, ownerEmail } from '../helpers/auth';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';

// The real server action reads headers through next/headers; point it at a mutable test cookie.
const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));

let admin: Sql;
const db = () => getDb();

beforeAll(() => {
  admin = migratorSql();
});

beforeEach(async () => {
  await resetDb(admin);
  requestHeaders.current = new Headers();
});

afterAll(async () => {
  await closeAllDb();
});

function signInRequest(email: string, password: string, ip: string): Request {
  return new Request('http://localhost:3000/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  });
}

describe('owner creation and mandatory TOTP', () => {
  it('creates one owner with a hashed password and is idempotent', async () => {
    const first = await createOwnerUser({ email: ownerEmail(), name: 'Owner', password: OWNER_PASSWORD });
    const second = await createOwnerUser({ email: ownerEmail(), name: 'Owner', password: 'a-different-password-123' });
    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, userId: first.userId });

    const rows = await admin<{ password: string | null }[]>`SELECT password FROM auth_account WHERE provider_id = 'credential'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.password).toBeTruthy();
    expect(rows[0]?.password).not.toContain(OWNER_PASSWORD);
  });

  it('a password-only session is NOT accepted until TOTP is enrolled (guard enforces "TOTP required")', async () => {
    await createOwnerUser({ email: ownerEmail(), name: 'Owner', password: OWNER_PASSWORD });
    const signedIn = await getAuth().api.signInEmail({
      body: { email: ownerEmail(), password: OWNER_PASSWORD },
      returnHeaders: true,
    });
    const cookie = cookieHeaderFromSetCookies(signedIn.headers.getSetCookie());
    expect(cookie).toContain('session_token');
    expect(await checkOwner(headersWith(cookie))).toEqual({ ok: false, reason: 'two_factor_required' });
  });

  it('enrolls TOTP from a script, then sign-in demands the second factor before issuing a session', async () => {
    await createOwnerUser({ email: ownerEmail(), name: 'Owner', password: OWNER_PASSWORD });
    const enrollment = await beginTotpEnrollment({ email: ownerEmail(), password: OWNER_PASSWORD });
    const secret = secretFromOtpauthUri(enrollment.totpURI);
    expect(enrollment.totpURI.startsWith('otpauth://totp/')).toBe(true);
    expect(enrollment.backupCodes.length).toBeGreaterThanOrEqual(5);

    // Not enforced until the authenticator proves it works.
    const [before] = await db().select().from(userTable).where(eq(userTable.email, ownerEmail()));
    expect(before?.twoFactorEnabled).toBe(false);
    await enrollment.confirm(totp(secret));
    const [after] = await db().select().from(userTable).where(eq(userTable.email, ownerEmail()));
    expect(after?.twoFactorEnabled).toBe(true);

    // Password alone now yields a challenge and NO session cookie.
    const challenge = await getAuth().api.signInEmail({ body: { email: ownerEmail(), password: OWNER_PASSWORD }, returnHeaders: true });
    expect(challenge.response).toMatchObject({ twoFactorRedirect: true });
    const challengeCookie = cookieHeaderFromSetCookies(challenge.headers.getSetCookie());
    expect(challengeCookie).not.toContain('session_token');
    expect(await checkOwner(headersWith(challengeCookie))).toEqual({ ok: false, reason: 'unauthenticated' });

    // A wrong code is refused; the right code issues a session the guard accepts.
    await expect(
      getAuth().api.verifyTOTP({ body: { code: '000000' }, headers: headersWith(challengeCookie) }),
    ).rejects.toThrow();
    const { cookie } = await signInOwner({ email: ownerEmail(), password: OWNER_PASSWORD, totpCode: totp(secret) });
    expect(await checkOwner(headersWith(cookie))).toMatchObject({ ok: true, owner: { email: ownerEmail() } });
  });

  it('refuses a wrong password', async () => {
    await createEnrolledOwner();
    await expect(getAuth().api.signInEmail({ body: { email: ownerEmail(), password: 'not-the-password-123' } })).rejects.toThrow();
  });

  it('a user who is not the configured owner is never accepted, even with a valid session', async () => {
    await createOwnerUser({ email: 'someone.else@example.test', name: 'Someone', password: OWNER_PASSWORD });
    const signedIn = await getAuth().api.signInEmail({
      body: { email: 'someone.else@example.test', password: OWNER_PASSWORD },
      returnHeaders: true,
    });
    const cookie = cookieHeaderFromSetCookies(signedIn.headers.getSetCookie());
    expect(await checkOwner(headersWith(cookie))).toEqual({ ok: false, reason: 'not_owner' });
  });

  it('public sign-up is disabled', async () => {
    const response = await getAuth().handler(
      new Request('http://localhost:3000/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'intruder@example.test', password: 'a-long-enough-password', name: 'Intruder' }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await db().select().from(userTable).where(eq(userTable.email, 'intruder@example.test'))).toHaveLength(0);
  });

  it('reset removes TOTP, rotates the password and revokes existing sessions', async () => {
    const owner = await createEnrolledOwner();
    await resetOwnerCredentials({ userId: owner.userId, password: 'brand-new-password-456' });

    expect(await checkOwner(headersWith(owner.cookie))).toEqual({ ok: false, reason: 'unauthenticated' });
    await expect(getAuth().api.signInEmail({ body: { email: owner.email, password: OWNER_PASSWORD } })).rejects.toThrow();
    const [row] = await db().select().from(userTable).where(eq(userTable.id, owner.userId));
    expect(row?.twoFactorEnabled).toBe(false);
    const factors = await admin`SELECT 1 FROM auth_two_factor`;
    expect(factors).toHaveLength(0);
  });
});

describe('guard', () => {
  it('rejects requests with no session', async () => {
    expect(await checkOwner(new Headers())).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('rejects a forged or garbage session cookie', async () => {
    expect(await checkOwner(headersWith('better-auth.session_token=forged.value'))).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
  });

  it('accepts the fully authenticated owner', async () => {
    const owner = await createEnrolledOwner();
    expect(await checkOwner(headersWith(owner.cookie))).toMatchObject({ ok: true, owner: { userId: owner.userId } });
  });
});

describe('login rate limit (5 attempts / 15 min / IP, stored in Postgres)', () => {
  it('blocks the 6th failed attempt from one IP but not another IP', async () => {
    await createEnrolledOwner();
    const auth = getAuth();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await auth.handler(signInRequest(ownerEmail(), 'wrong-password-12345', '203.0.113.9'));
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }
    const blocked = await auth.handler(signInRequest(ownerEmail(), 'wrong-password-12345', '203.0.113.9'));
    expect(blocked.status).toBe(429);

    const otherIp = await auth.handler(signInRequest(ownerEmail(), 'wrong-password-12345', '198.51.100.4'));
    expect(otherIp.status).toBe(401);

    const rows = await admin`SELECT count(*)::int AS n FROM auth_rate_limit`;
    expect(rows[0]?.n).toBeGreaterThan(0);
  });
});

describe('ownerAction wrapper', () => {
  const schema = killSwitchInputSchema;

  it('rejects an unauthenticated caller before validating input, running the handler, or auditing', async () => {
    const handler = vi.fn(async () => ({ data: 1, audit: { action: 'x', entityType: 'x', entityId: '1' } }));
    const action = createOwnerAction(async () => new Headers())({ name: 'test.action', schema, handler });

    const result = await action({ name: 'ai_paused', value: true });
    expect(result).toEqual({ ok: false, error: { code: 'unauthorized', message: 'You must be signed in as the owner.' } });
    expect(handler).not.toHaveBeenCalled();
    expect(await db().select().from(auditLog)).toHaveLength(0);
    // Invalid input from an unauthenticated caller must reveal nothing about the schema.
    expect(await action({ nonsense: true })).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects a password-only session (no TOTP) as unauthorized', async () => {
    await createOwnerUser({ email: ownerEmail(), name: 'Owner', password: OWNER_PASSWORD });
    const signedIn = await getAuth().api.signInEmail({ body: { email: ownerEmail(), password: OWNER_PASSWORD }, returnHeaders: true });
    const cookie = cookieHeaderFromSetCookies(signedIn.headers.getSetCookie());
    const handler = vi.fn();
    const action = createOwnerAction(async () => headersWith(cookie))({ name: 'test.action', schema, handler });
    expect(await action({ name: 'ai_paused', value: true })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns field errors for invalid input and does not run the handler', async () => {
    const owner = await createEnrolledOwner();
    const handler = vi.fn();
    const action = createOwnerAction(async () => headersWith(owner.cookie))({ name: 'test.action', schema, handler });
    const result = await action({ name: 'not_a_switch', value: 'yes' });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    if (!result.ok) expect(Object.keys(result.error.fieldErrors ?? {}).sort()).toEqual(['name', 'value']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler and writes the audit entry in one transaction', async () => {
    const owner = await createEnrolledOwner();
    const action = createOwnerAction(async () => headersWith(owner.cookie))({
      name: 'test.action',
      schema,
      handler: async ({ input, tx, owner: who }) => {
        const change = await applyKillSwitch(tx, input);
        return {
          data: change,
          audit: { action: 'settings.kill_switch', entityType: 'settings', entityId: '1', metadata: { by: who.userId, ...change } },
        };
      },
    });

    const result = await action({ name: 'ai_paused', value: true });
    expect(result).toEqual({ ok: true, data: { name: 'ai_paused', previous: false, value: true } });
    const [row] = await db().select().from(settings);
    expect(row?.aiPaused).toBe(true);
    // (creating the owner also audits `owner.create` as the system actor, so scope to the owner's entries)
    const audit = await db().select().from(auditLog).where(eq(auditLog.actor, 'owner'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'owner', action: 'settings.kill_switch', entityType: 'settings', entityId: '1' });
    expect(audit[0]?.metadata).toMatchObject({ by: owner.userId, name: 'ai_paused', value: true });
  });

  it('rolls back the mutation AND the audit entry when the handler throws, without leaking the error', async () => {
    const owner = await createEnrolledOwner();
    const action = createOwnerAction(async () => headersWith(owner.cookie))({
      name: 'test.action',
      schema,
      handler: async ({ input, tx }) => {
        await applyKillSwitch(tx, input);
        throw new Error('secret internal detail: password=hunter2');
      },
    });

    const result = await action({ name: 'sending_paused', value: true });
    expect(result).toEqual({ ok: false, error: { code: 'failed', message: 'Something went wrong. Nothing was changed.' } });
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(await db().select().from(settings)).toHaveLength(0);
    expect(await db().select().from(auditLog).where(eq(auditLog.actor, 'owner'))).toHaveLength(0);
  });
});

describe('ownerAction: refusals and after-commit hooks', () => {
  const schema = z.object({ name: z.enum(['ai_paused', 'sending_paused', 'autopilot_paused']), value: z.boolean() });

  it('a refusal rolls back the mutation and the audit entry and tells the owner WHY (code refused, reason, message)', async () => {
    const owner = await createEnrolledOwner();
    const action = createOwnerAction(async () => headersWith(owner.cookie))({
      name: 'test.refuse',
      schema,
      handler: async ({ input, tx }) => {
        await applyKillSwitch(tx, input);
        throw new ActionRefusal('window_closed', 'The 24-hour window has closed.');
      },
    });

    const result = await action({ name: 'ai_paused', value: true });
    expect(result).toEqual({ ok: false, error: { code: 'refused', reason: 'window_closed', message: 'The 24-hour window has closed.' } });
    expect(await db().select().from(settings)).toHaveLength(0);
    expect(await db().select().from(auditLog).where(eq(auditLog.actor, 'owner'))).toHaveLength(0);
  });

  it('afterCommit runs once, AFTER the transaction committed (it can see the change)', async () => {
    const owner = await createEnrolledOwner();
    let seenInHook: boolean | undefined;
    const action = createOwnerAction(async () => headersWith(owner.cookie))({
      name: 'test.after',
      schema,
      handler: async ({ input, tx }) => {
        const change = await applyKillSwitch(tx, input);
        return {
          data: change,
          audit: { action: 'settings.kill_switch', entityType: 'settings', entityId: '1', metadata: { ...change } },
          afterCommit: async () => {
            // A different connection: it only sees the row if the transaction has committed.
            const [row] = await admin`SELECT ai_paused FROM settings`;
            seenInHook = row?.ai_paused as boolean | undefined;
          },
        };
      },
    });
    expect(await action({ name: 'ai_paused', value: true })).toMatchObject({ ok: true });
    expect(seenInHook).toBe(true);
  });

  it('afterCommit NEVER runs when the transaction rolls back (here: the audit write fails after the handler succeeded)', async () => {
    const owner = await createEnrolledOwner();
    const hook = vi.fn(async () => undefined);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const action = createOwnerAction(async () => headersWith(owner.cookie))({
      name: 'test.never',
      schema,
      handler: async ({ input, tx }) => {
        const change = await applyKillSwitch(tx, input);
        return { data: change, audit: { action: 'settings.kill_switch', entityType: 'settings', entityId: '1', metadata: circular }, afterCommit: hook };
      },
    });
    expect(await action({ name: 'ai_paused', value: true })).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(hook).not.toHaveBeenCalled();
    expect(await db().select().from(settings)).toHaveLength(0);
  });

  it('a failing afterCommit does not turn a committed change into an error', async () => {
    const owner = await createEnrolledOwner();
    const action = createOwnerAction(async () => headersWith(owner.cookie))({
      name: 'test.hookfail',
      schema,
      handler: async ({ input, tx }) => {
        const change = await applyKillSwitch(tx, input);
        return {
          data: change,
          audit: { action: 'settings.kill_switch', entityType: 'settings', entityId: '1', metadata: { ...change } },
          afterCommit: async () => {
            throw new Error('redis down');
          },
        };
      },
    });
    expect(await action({ name: 'sending_paused', value: true })).toMatchObject({ ok: true, data: { name: 'sending_paused', value: true } });
    expect((await db().select().from(settings))[0]?.sendingPaused).toBe(true);
  });
});

describe('setKillSwitch (the real server action)', () => {
  it('is rejected without a session, and changes nothing', async () => {
    const { setKillSwitch } = await import('@/actions/settings');
    requestHeaders.current = new Headers();
    const result = await setKillSwitch({ name: 'sending_paused', value: true });
    expect(result).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(await db().select().from(settings)).toHaveLength(0);
    expect(await db().select().from(auditLog)).toHaveLength(0);
  });

  it('flips each switch for the owner, remembers the previous value, and audits it', async () => {
    const { setKillSwitch } = await import('@/actions/settings');
    const owner = await createEnrolledOwner();
    requestHeaders.current = headersWith(owner.cookie);

    expect(await setKillSwitch({ name: 'autopilot_paused', value: false })).toEqual({
      ok: true,
      data: { name: 'autopilot_paused', previous: true, value: false },
    });
    expect(await setKillSwitch({ name: 'ai_paused', value: true })).toMatchObject({ ok: true, data: { previous: false, value: true } });
    expect(await setKillSwitch({ name: 'sending_paused', value: true })).toMatchObject({ ok: true });
    expect(await setKillSwitch({ name: 'sending_paused', value: false })).toMatchObject({ ok: true, data: { previous: true, value: false } });

    const [row] = await db().select().from(settings);
    expect(row).toMatchObject({ aiPaused: true, sendingPaused: false, autopilotPaused: false });
    const audit = await db().select().from(auditLog).where(eq(auditLog.action, 'settings.kill_switch'));
    expect(audit).toHaveLength(4);
  });

  it('rejects unknown switch names', async () => {
    const { setKillSwitch } = await import('@/actions/settings');
    const owner = await createEnrolledOwner();
    requestHeaders.current = headersWith(owner.cookie);
    expect(await setKillSwitch({ name: 'drop_tables', value: true })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });
});
