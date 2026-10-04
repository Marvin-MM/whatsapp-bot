import { describe, expect, it } from 'vitest';
import { sha256Hex, stableStringify } from '@/lib/hash';
import {
  appStateItemSchema,
  echoItemSchema,
  historyItemSchema,
  messageItemSchema,
  otherItemSchema,
  parseEnvelope,
  statusItemSchema,
  userIdUpdateItemSchema,
  userPreferenceItemSchema,
} from '@/lib/whatsapp/webhook-schema';
import { type EventKind, type SplitItem, splitEnvelope } from '@/lib/whatsapp/webhook-split';
import { allFixtureNames, fixtureJson, manifest } from '../helpers/fixtures';

function split(name: string): SplitItem[] {
  const parsed = parseEnvelope(fixtureJson(name));
  if (!parsed.ok) throw new Error(`fixture ${name} is not a valid envelope: ${parsed.reason}`);
  return splitEnvelope(parsed.envelope);
}

const summary = (name: string) => split(name).map((item) => [item.kind, item.dedupeKey] as [EventKind, string]);

/** Written out from the fixtures' contents, independently of the splitter. */
const EXPECTED: Record<string, Array<[EventKind, string]>> = {
  'text-message': [['message', 'msg:wamid.IN.TEXT.1']],
  'batch-multi': [
    ['message', 'msg:wamid.BATCH.1'],
    ['message', 'msg:wamid.BATCH.2'],
    ['status', 'status:wamid.OUT.BATCH.1:delivered'],
    ['message', 'msg:wamid.BATCH.3'],
    ['message', 'msg:wamid.BATCH.4'],
  ],
  'image-caption': [['message', 'msg:wamid.IN.IMG.1']],
  'voice-note': [['message', 'msg:wamid.IN.AUD.1']],
  reaction: [['message', 'msg:wamid.IN.RXN.1']],
  'bsuid-only-sender': [['message', 'msg:wamid.IN.BSUID.1']],
  'edit-live': [['message', 'msg:wamid.IN.EDIT.1:edited']],
  'revoke-live': [['message', 'msg:wamid.IN.REVOKE.1:revoked']],
  'status-sent': [['status', 'status:wamid.OUT.TEXT.1:sent']],
  'status-delivered': [['status', 'status:wamid.OUT.TEXT.1:delivered']],
  'status-read': [['status', 'status:wamid.OUT.TEXT.1:read']],
  'status-played': [['status', 'status:wamid.OUT.AUD.1:played']],
  'status-failed': [['status', 'status:wamid.OUT.FAIL.1:failed']],
  'echo-message-echoes': [['echo', 'echo:wamid.ECHO.1']],
  'echo-messages-shape': [['echo', 'echo:wamid.ECHO.2']],
  'echo-to-bsuid': [['echo', 'echo:wamid.ECHO.3']],
  'echo-edit': [['echo', 'echo:wamid.ECHO.EDIT.1:edited']],
  'echo-revoke': [['echo', 'echo:wamid.ECHO.REVOKE.1:revoked']],
  'user-id-update': [['user_id_update', 'uidupd:UG.13491208655302741918:UG.55555555555555555555']],
  'app-state-contact-remove': [['app_state', expect.stringMatching(/^appstate:[0-9a-f]{64}$/) as unknown as string]],
  'account-partner-removed': [['account', expect.stringMatching(/^account:account_update:[0-9a-f]{64}$/) as unknown as string]],
  'account-offboarded': [['account', expect.stringMatching(/^account:account_offboarded:[0-9a-f]{64}$/) as unknown as string]],
  'account-reconnected': [['account', expect.stringMatching(/^account:account_reconnected:[0-9a-f]{64}$/) as unknown as string]],
  'quality-update': [['account', expect.stringMatching(/^account:phone_number_quality_update:/) as unknown as string]],
  'template-status-update': [['other', expect.stringMatching(/^other:message_template_status_update:/) as unknown as string]],
  'unknown-field': [['other', expect.stringMatching(/^other:coexistence_fixture_unknown_field:/) as unknown as string]],
  'malformed-empty-entry': [],
};

describe('parseEnvelope', () => {
  it('accepts a WhatsApp envelope, including one with an empty entry list', () => {
    expect(parseEnvelope(fixtureJson('text-message')).ok).toBe(true);
    expect(parseEnvelope(fixtureJson('malformed-empty-entry')).ok).toBe(true);
  });

  it('separates "not our product" from "our product, unparseable"', () => {
    expect(parseEnvelope(fixtureJson('other-object-page'))).toEqual({ ok: false, reason: 'wrong_object', object: 'page' });
    expect(parseEnvelope(fixtureJson('malformed-missing-object'))).toEqual({ ok: false, reason: 'wrong_object' });
    expect(parseEnvelope({ object: 'whatsapp_business_account', entry: 'nope' })).toEqual({ ok: false, reason: 'invalid_shape' });
  });

  it.each([null, 42, 'text', [], undefined])('rejects a non-object body (%j)', (value) => {
    expect(parseEnvelope(value)).toEqual({ ok: false, reason: 'not_json_object' });
  });

  it('keeps unknown extra fields instead of rejecting them (forward compatibility)', () => {
    const parsed = parseEnvelope({ object: 'whatsapp_business_account', entry: [], brand_new_field: { a: 1 } });
    expect(parsed.ok).toBe(true);
  });
});

describe('splitEnvelope: expected events per fixture', () => {
  it.each(Object.entries(EXPECTED))('%s', (name, expected) => {
    expect(summary(name)).toEqual(expected);
  });

  it('iterates EVERY entry, change and item of a batch (never just index 0)', () => {
    const items = split('batch-multi');
    expect(items.filter((item) => item.kind === 'message')).toHaveLength(4);
    expect(items.filter((item) => item.kind === 'status')).toHaveLength(1);
  });

  it('parks a known field whose value does not parse, flagging it', () => {
    const [only] = split('malformed-messages-value');
    expect(only?.kind).toBe('other');
    expect(only?.item).toMatchObject({ field: 'messages', parseError: true });
  });

  it('keeps unknown fields and account events verbatim', () => {
    const [account] = split('account-partner-removed');
    expect(account?.item).toMatchObject({ field: 'account_update', value: { event: 'PARTNER_REMOVED' } });
  });
});

describe('splitEnvelope: history', () => {
  it('uses chunk-level keys carrying request id, phase and a content hash', () => {
    const [chunk] = split('history-flat-phase1');
    expect(chunk?.kind).toBe('history');
    expect(chunk?.dedupeKey).toMatch(/^history:req_hist_1:1:[0-9a-f]{64}$/);
  });

  it('gives a replayed chunk the SAME key, so a re-delivered or duplicated chunk dedupes', () => {
    expect(split('history-duplicate-chunk')[0]?.dedupeKey).toBe(split('history-flat-phase1')[0]?.dedupeKey);
  });

  it('is insensitive to key order inside the chunk', () => {
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reorder(inner)]))
          : value;
    const parsed = parseEnvelope(reorder(fixtureJson('history-flat-phase1')));
    if (!parsed.ok) throw new Error('reordered fixture should still parse');
    expect(splitEnvelope(parsed.envelope)[0]?.dedupeKey).toBe(split('history-flat-phase1')[0]?.dedupeKey);
  });

  it('gives different chunks different keys', () => {
    expect(split('history-flat-phase1')[0]?.dedupeKey).not.toBe(split('history-complete')[0]?.dedupeKey);
  });

  it('handles the threads[] shape and error-only payloads', () => {
    expect(split('history-threads')[0]?.kind).toBe('history');
    const [error] = split('history-error');
    expect(error?.dedupeKey).toMatch(/^history-error:req_hist_err:/);
    expect(error?.item).toMatchObject({ errors: [{ code: 2593109 }] });
  });
});

describe('splitEnvelope: general properties', () => {
  it('is deterministic', () => {
    for (const name of allFixtureNames().filter((fixture) => parseEnvelope(fixtureJson(fixture)).ok)) {
      expect(split(name)).toEqual(split(name));
    }
  });

  it('keeps a key that repeats inside one payload only once', () => {
    const doubled = {
      object: 'whatsapp_business_account',
      entry: [
        { id: 'w', changes: [{ field: 'messages', value: { metadata: {}, messages: [{ id: 'same', type: 'text' }, { id: 'same', type: 'text' }] } }] },
        { id: 'w', changes: [{ field: 'messages', value: { metadata: {}, messages: [{ id: 'same', type: 'text' }] } }] },
      ],
    };
    const parsed = parseEnvelope(doubled);
    if (!parsed.ok) throw new Error('should parse');
    expect(splitEnvelope(parsed.envelope)).toHaveLength(1);
  });

  it('distinguishes an edit or revoke from the original, so it is not dropped as a replay', () => {
    const keys = [...split('text-message'), ...split('edit-live'), ...split('revoke-live')].map((item) => item.dedupeKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('keeps replays of an id-less event collapsed but lets a recurring state through (keyed on the entry time)', () => {
    const quality = (time: number) => {
      const parsed = parseEnvelope({
        object: 'whatsapp_business_account',
        entry: [{ id: 'w', time, changes: [{ field: 'phone_number_quality_update', value: { event: 'FLAGGED', current_limit: 'TIER_1K' } }] }],
      });
      if (!parsed.ok) throw new Error('should parse');
      return splitEnvelope(parsed.envelope)[0]?.dedupeKey;
    };
    expect(quality(1791100000)).toBe(quality(1791100000)); // Meta's retry of the same entry
    expect(quality(1791100000)).not.toBe(quality(1791200000)); // the same state recurring a day later

    const rename = (time: number) => {
      const parsed = parseEnvelope({
        object: 'whatsapp_business_account',
        entry: [{ id: 'w', time, changes: [{ field: 'smb_app_state_sync', value: { metadata: {}, contacts: [{ wa_id: '256700123456', profile: { name: 'Amina' } }] } }] }],
      });
      if (!parsed.ok) throw new Error('should parse');
      return splitEnvelope(parsed.envelope)[0]?.dedupeKey;
    };
    // "Amina" -> "A" -> "Amina": the second "Amina" must not be deduped against the first.
    expect(rename(1791100000)).not.toBe(rename(1791300000));
  });

  it('every fixture is classified in the manifest', () => {
    const recorded = manifest();
    for (const name of allFixtureNames()) {
      expect(recorded[`${name}.json`], `${name} missing from index.json`).toBeDefined();
    }
  });
});

describe('every split item is self-contained and re-validates against its stored-item schema', () => {
  const schemas: Record<EventKind, { safeParse: (value: unknown) => { success: boolean } }> = {
    message: messageItemSchema,
    status: statusItemSchema,
    echo: echoItemSchema,
    history: historyItemSchema,
    app_state: appStateItemSchema,
    user_id_update: userIdUpdateItemSchema,
    user_preferences: userPreferenceItemSchema,
    account: otherItemSchema,
    other: otherItemSchema,
  };

  it.each(allFixtureNames().filter((name) => parseEnvelope(fixtureJson(name)).ok))('%s', (name) => {
    for (const item of split(name)) {
      expect(schemas[item.kind].safeParse(item.item).success, `${name}: ${item.dedupeKey}`).toBe(true);
      // The item is what gets stored; it must survive a JSON round trip unchanged.
      expect(JSON.parse(JSON.stringify(item.item))).toEqual(JSON.parse(JSON.stringify(item.item)));
    }
  });
});

describe('hash helpers', () => {
  it('stableStringify sorts keys recursively and ignores undefined', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: undefined, b: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"b":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  it('sha256Hex matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
