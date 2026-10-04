import { describe, expect, it } from 'vitest';
import { handleOther } from '@/lib/ingest/account';
import type { IngestContext } from '@/lib/ingest/context';
import { stripNulChars } from '@/lib/ingest/sanitize';
import { echoCounterpart, inboundIdentity, senderEntry } from '@/lib/ingest/sender';
import { messageSchema, otherItemSchema, contactSchema } from '@/lib/whatsapp/webhook-schema';

const message = (raw: Record<string, unknown>) => messageSchema.parse({ id: 'wamid.X', ...raw });
const contact = (raw: Record<string, unknown>) => contactSchema.parse(raw);

describe('inboundIdentity', () => {
  it('uses from + the contacts entry for a classic phone-based sender', () => {
    const identity = inboundIdentity(
      message({ from: '256700123456', from_user_id: 'UG.13491208655302741918' }),
      [contact({ wa_id: '256700123456', user_id: 'UG.13491208655302741918', profile: { name: 'Amina', username: 'amina_u' } })],
    );
    expect(identity).toEqual({ bsuid: 'UG.13491208655302741918', phone: '256700123456', profileName: 'Amina', username: 'amina_u' });
  });

  it('survives a username user: no `from`, no wa_id, only a BSUID', () => {
    const identity = inboundIdentity(message({ from_user_id: 'UG.99999999999999999999' }), [contact({ user_id: 'UG.99999999999999999999', profile: { name: 'Kato' } })]);
    expect(identity.bsuid).toBe('UG.99999999999999999999');
    expect(identity.phone).toBeUndefined();
    expect(identity.profileName).toBe('Kato');
  });

  it('accepts a BSUID in `from` (the field can hold either kind of id)', () => {
    expect(inboundIdentity(message({ from: 'UG.13491208655302741918' }), undefined)).toMatchObject({ bsuid: 'UG.13491208655302741918', phone: undefined });
  });

  it('picks the contacts entry that describes the sender, not just the first one', () => {
    const entries = [contact({ wa_id: '111111111111', profile: { name: 'Other' } }), contact({ wa_id: '256700123456', profile: { name: 'Right' } })];
    expect(senderEntry(message({ from: '256700123456' }), entries)?.profile?.name).toBe('Right');
    expect(inboundIdentity(message({ from: '256700123456' }), entries).profileName).toBe('Right');
  });

  it('does not guess when several entries exist and none matches', () => {
    const entries = [contact({ wa_id: '111111111111' }), contact({ wa_id: '222222222222' })];
    expect(senderEntry(message({ from: '256700123456' }), entries)).toBeUndefined();
  });
});

describe('echoCounterpart: who the owner wrote to', () => {
  const own = '256700000001';

  it('reads `to`', () => {
    expect(echoCounterpart(message({ from: own, to: '256700123456' }), own)).toEqual({ bsuid: undefined, phone: '256700123456' });
  });

  it('reads a BSUID recipient', () => {
    expect(echoCounterpart(message({ from: own, to_user_id: 'UG.99999999999999999999' }), own)).toEqual({ bsuid: 'UG.99999999999999999999', phone: undefined });
    expect(echoCounterpart(message({ from: own, to: 'UG.99999999999999999999' }), own)).toEqual({ bsuid: 'UG.99999999999999999999', phone: undefined });
  });

  it('returns both when both are named', () => {
    expect(echoCounterpart(message({ from: own, to: '256700123456', to_user_id: 'UG.13491208655302741918' }), own)).toEqual({
      bsuid: 'UG.13491208655302741918',
      phone: '256700123456',
    });
  });

  it('returns null when no recipient is named: a guess would file the owner’s words in the wrong thread', () => {
    expect(echoCounterpart(message({ from: own }), own)).toBeNull();
  });

  it('never treats our own number as the customer', () => {
    expect(echoCounterpart(message({ from: own, to: '+256 700 000 001' }), own)).toBeNull();
  });
});

describe('handleOther: account events become alerts, noise does not', () => {
  const ctx: IngestContext = { now: new Date(), ownNumber: null, transcribeAudio: true, eventKey: 'account:test:1', finalAttempt: false };
  const run = (field: string, value: unknown, extra: Record<string, unknown> = {}) => handleOther(otherItemSchema.parse({ field, value, ...extra }), ctx);
  const alertOf = (result: ReturnType<typeof run>) => result.effects.flatMap((effect) => (effect.type === 'alert' ? [effect.alert] : []));

  it('treats a removed partner as critical', () => {
    const [alert] = alertOf(run('account_update', { event: 'PARTNER_REMOVED', waba_id: '123' }));
    expect(alert).toMatchObject({ kind: 'account_partner_removed', severity: 'critical', entityId: '123', dedupeKey: 'account_partner_removed:account:test:1' });
  });

  it('is case-insensitive about the event name and ignores events that need no action', () => {
    expect(alertOf(run('account_update', { event: 'partner_removed' }))).toHaveLength(1);
    expect(alertOf(run('account_update', { event: 'PARTNER_ADDED' }))).toHaveLength(0);
    expect(alertOf(run('account_update', {}))).toHaveLength(0);
  });

  it('flags offboarding critical and reconnection informational', () => {
    expect(alertOf(run('account_offboarded', {}))[0]).toMatchObject({ severity: 'critical' });
    expect(alertOf(run('account_reconnected', {}))[0]).toMatchObject({ severity: 'info' });
  });

  it('alerts on a degraded quality rating but not an upgrade', () => {
    expect(alertOf(run('phone_number_quality_update', { event: 'FLAGGED' }))[0]).toMatchObject({ kind: 'phone_quality_degraded', severity: 'warning' });
    expect(alertOf(run('phone_number_quality_update', { event: 'DOWNGRADE' }))).toHaveLength(1);
    expect(alertOf(run('phone_number_quality_update', { event: 'UPGRADE' }))).toHaveLength(0);
  });

  it('alerts when a display name is not approved', () => {
    expect(alertOf(run('phone_number_name_update', { decision: 'REJECTED' }))).toHaveLength(1);
    expect(alertOf(run('phone_number_name_update', { decision: 'APPROVED' }))).toHaveLength(0);
  });

  it('alerts on a payload that was parked because it did not match its schema', () => {
    expect(alertOf(run('messages', { junk: true }, { parseError: true }))[0]).toMatchObject({ kind: 'webhook_unparseable', severity: 'warning', entityId: 'messages' });
    expect(alertOf(run('envelope', {}, { parseError: true }))[0]).toMatchObject({ kind: 'webhook_unparseable' });
  });

  it('alerts when the messages field carried top-level errors', () => {
    expect(alertOf(run('messages', { errors: [{ code: 131000 }] }))[0]).toMatchObject({ kind: 'webhook_messages_error' });
  });

  it('records fields it does not act on without alerting', () => {
    const result = run('message_template_status_update', { event: 'APPROVED' });
    expect(alertOf(result)).toHaveLength(0);
    expect(result.note).toBe('field_recorded_only');
  });

  it('caps the alert entity id at 64 characters', () => {
    const [alert] = alertOf(run('account_update', { event: 'PARTNER_REMOVED', waba_id: 'x'.repeat(200) }));
    expect(alert?.entityId).toHaveLength(64);
  });
});

describe('stripNulChars', () => {
  it('removes U+0000 from every string in a payload, keys included, and leaves the rest alone', () => {
    const dirty = { 'ke\u0000y': ['a\u0000b', { body: 'he\u0000llo' }], n: 5, ok: true, nothing: null };
    expect(stripNulChars(dirty)).toEqual({ key: ['ab', { body: 'hello' }], n: 5, ok: true, nothing: null });
  });

  it('returns clean input unchanged', () => {
    expect(stripNulChars({ a: 'b', c: [1, 2] })).toEqual({ a: 'b', c: [1, 2] });
  });
});
