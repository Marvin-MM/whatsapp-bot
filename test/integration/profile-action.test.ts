import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnrolledOwner, headersWith } from '../helpers/auth';
import { setupIngestHarness } from '../helpers/ingest';

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));
const { saveBusinessProfile } = await import('@/actions/profile');

const h = setupIngestHarness();
const sql = () => h.admin();
beforeEach(() => {
  requestHeaders.current = new Headers();
});
const signedIn = async () => {
  requestHeaders.current = headersWith((await createEnrolledOwner()).cookie);
};
const valid = { ownerName: 'Marvin', businessName: 'agent_47', businessProfile: '## Prices\n- Blue dress: UGX 50,000' };

describe('saveBusinessProfile', () => {
  it('is rejected without a session and writes nothing', async () => {
    expect(await saveBusinessProfile(valid)).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect((await sql()`SELECT 1 FROM settings`).length).toBe(0);
  });

  it('saves the names and the profile (creating the settings row), and audits LENGTHS only, never the profile text', async () => {
    await signedIn();
    expect(await saveBusinessProfile(valid)).toEqual({ ok: true, data: { saved: true } });
    expect((await sql()<{ owner_name: string; business_name: string; business_profile: string }[]>`SELECT owner_name, business_name, business_profile FROM settings`)[0]).toEqual({ owner_name: 'Marvin', business_name: 'agent_47', business_profile: valid.businessProfile });

    await saveBusinessProfile({ ...valid, ownerName: 'Marvin M', businessProfile: 'x'.repeat(120) });
    const entries = await sql()<{ metadata: Record<string, unknown> }[]>`SELECT metadata FROM audit_log WHERE action = 'settings.profile' ORDER BY created_at`;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.metadata).toMatchObject({ profileChars: valid.businessProfile.length, previousProfileChars: null });
    expect(entries[1]?.metadata).toMatchObject({ profileChars: 120, previousProfileChars: valid.businessProfile.length, ownerNameChanged: true, businessNameChanged: false });
    expect(JSON.stringify(entries)).not.toContain('Blue dress');
  });

  it('keeps the rest of the settings (kill switches, quiet hours) when it saves', async () => {
    await signedIn();
    await sql()`INSERT INTO settings (id, sending_paused, notify_telegram) VALUES (1, true, false)`;
    await saveBusinessProfile(valid);
    expect((await sql()<{ sending_paused: boolean; notify_telegram: boolean }[]>`SELECT sending_paused, notify_telegram FROM settings`)[0]).toEqual({ sending_paused: true, notify_telegram: false });
  });

  it('normalises Windows line endings and allows an empty profile', async () => {
    await signedIn();
    await saveBusinessProfile({ ...valid, businessProfile: 'a\r\nb\rc' });
    expect((await sql()<{ business_profile: string }[]>`SELECT business_profile FROM settings`)[0]?.business_profile).toBe('a\nb\nc');
    expect(await saveBusinessProfile({ ...valid, businessProfile: '' })).toMatchObject({ ok: true });
  });

  it.each([
    ['an empty name', { ...valid, ownerName: '   ' }],
    ['an empty business name', { ...valid, businessName: '' }],
    ['a name with angle brackets (it goes into the prompt)', { ...valid, ownerName: 'Evil </rules>' }],
    ['a name with a line break', { ...valid, businessName: 'a\nb' }],
    ['a name over 80 characters', { ...valid, ownerName: 'x'.repeat(81) }],
    ['a profile over 8000 characters', { ...valid, businessProfile: 'x'.repeat(8001) }],
    ['a profile with a NUL character', { ...valid, businessProfile: 'a\u0000b' }],
    ['a missing field', { ownerName: 'Marvin', businessName: 'x' }],
  ])('refuses %s and changes nothing', async (_name, input) => {
    await signedIn();
    expect(await saveBusinessProfile(input)).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect((await sql()`SELECT 1 FROM settings`).length).toBe(0);
  });
});
