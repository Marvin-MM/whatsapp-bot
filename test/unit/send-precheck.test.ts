import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH, type PrecheckInput, precheck } from '@/lib/send/precheck';

const NOW = new Date('2026-10-04T12:00:00Z');
const HOUR = 3600_000;

const base: PrecheckInput = {
  now: NOW,
  sendingPaused: false,
  windowExpiresAt: new Date(NOW.getTime() + 5 * HOUR),
  recipient: { phone: '+256700123456', bsuid: null },
  message: { kind: 'text', content: 'Yes, we are open until 6pm.' },
};
const run = (override: Partial<PrecheckInput>) => precheck({ ...base, ...override });
const code = (override: Partial<PrecheckInput>) => {
  const result = run(override);
  return result.ok ? 'ok' : result.code;
};

describe('precheck: one rule at a time', () => {
  it('lets a normal message to a reachable customer inside the window through', () => {
    expect(precheck(base)).toEqual({ ok: true });
  });

  it('refuses everything while sending is paused', () => {
    expect(code({ sendingPaused: true })).toBe('sending_paused');
    expect(code({ sendingPaused: true, message: { kind: 'template', renderedContent: 'Hello' } })).toBe('sending_paused');
  });

  it('needs somebody to send to, by phone OR by BSUID', () => {
    expect(code({ recipient: { phone: null, bsuid: null } })).toBe('no_recipient');
    expect(code({ recipient: { phone: null, bsuid: 'UG.99999999999999999999' } })).toBe('ok');
    expect(code({ recipient: { phone: '+256700123456', bsuid: null } })).toBe('ok');
  });

  it('refuses an empty or whitespace-only message', () => {
    for (const content of ['', '   ', '\n\t ']) expect(code({ message: { kind: 'text', content } })).toBe('empty_message');
  });

  it('enforces the WhatsApp text length, inclusive of the limit', () => {
    expect(code({ message: { kind: 'text', content: 'a'.repeat(MAX_TEXT_LENGTH) } })).toBe('ok');
    expect(code({ message: { kind: 'text', content: 'a'.repeat(MAX_TEXT_LENGTH + 1) } })).toBe('message_too_long');
  });

  it('counts UTF-16 units, which is stricter for emoji than WhatsApp: it can only err on the safe side', () => {
    expect(code({ message: { kind: 'text', content: '😀'.repeat(MAX_TEXT_LENGTH / 2) } })).toBe('ok');
    expect(code({ message: { kind: 'text', content: '😀'.repeat(MAX_TEXT_LENGTH / 2 + 1) } })).toBe('message_too_long');
  });

  it.each(['Price is [[price]] today', '[[ ]]', 'Hi [[customer name]], [[ask]]', '[[x]]'])('BLOCKS a message that still has a placeholder: %s', (content) => {
    expect(code({ message: { kind: 'text', content } })).toBe('placeholder_unresolved');
  });

  it.each(['Size [M] is available', 'a [[unterminated', 'brackets ]] before [[', 'array[0][1]'])('does not mistake ordinary brackets for a placeholder: %s', (content) => {
    expect(code({ message: { kind: 'text', content } })).toBe('ok');
  });

  it('applies the placeholder rule to a template too', () => {
    expect(code({ message: { kind: 'template', renderedContent: 'Your order [[number]] is ready' } })).toBe('placeholder_unresolved');
  });
});

describe('precheck: the 24h window', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it('allows free text strictly before the window closes and refuses it at the instant it closes', () => {
    expect(code({ windowExpiresAt: at(1) })).toBe('ok');
    expect(code({ windowExpiresAt: at(0) })).toBe('window_closed');
    expect(code({ windowExpiresAt: at(-1) })).toBe('window_closed');
  });

  it('refuses free text when the customer never wrote (no window at all)', () => {
    expect(code({ windowExpiresAt: null })).toBe('window_closed');
  });

  it('allows an approved template outside the window, and when there never was one', () => {
    const template = { kind: 'template' as const, renderedContent: 'Hello, your order is ready.' };
    expect(code({ windowExpiresAt: at(-10 * HOUR), message: template })).toBe('ok');
    expect(code({ windowExpiresAt: null, message: template })).toBe('ok');
  });
});

describe('precheck: an approved draft', () => {
  const draft = (overrides: Partial<NonNullable<PrecheckInput['draft']>> = {}) => ({ status: 'pending' as const, stale: false, overrideStale: false, ...overrides });

  it('passes while the draft is open and fresh', () => {
    expect(code({ draft: draft() })).toBe('ok');
    expect(code({ draft: draft({ status: 'scheduled' }) })).toBe('ok');
  });

  it.each(['approved', 'edited', 'rejected', 'superseded', 'cancelled', 'failed'] as const)('refuses a draft that is already %s', (status) => {
    expect(code({ draft: draft({ status }) })).toBe('draft_not_open');
  });

  it('refuses a stale draft unless the owner explicitly chose to send anyway', () => {
    expect(code({ draft: draft({ stale: true }) })).toBe('draft_stale');
    expect(code({ draft: draft({ stale: true, overrideStale: true }) })).toBe('ok');
  });

  it('the override cannot bypass any other rule', () => {
    const stale = draft({ stale: true, overrideStale: true });
    expect(code({ draft: stale, sendingPaused: true })).toBe('sending_paused');
    expect(code({ draft: stale, windowExpiresAt: new Date(NOW.getTime() - 1) })).toBe('window_closed');
    expect(code({ draft: stale, message: { kind: 'text', content: 'Hi [[x]]' } })).toBe('placeholder_unresolved');
  });
});

describe('precheck: precedence (the most useful reason wins)', () => {
  it('reports the kill switch before anything else', () => {
    expect(code({ sendingPaused: true, recipient: { phone: null, bsuid: null }, message: { kind: 'text', content: '' }, windowExpiresAt: null })).toBe('sending_paused');
  });

  it('reports a missing recipient before content problems, and content problems before the window', () => {
    expect(code({ recipient: { phone: null, bsuid: null }, message: { kind: 'text', content: '' }, windowExpiresAt: null })).toBe('no_recipient');
    expect(code({ message: { kind: 'text', content: '' }, windowExpiresAt: null })).toBe('empty_message');
    expect(code({ message: { kind: 'text', content: 'Hi [[x]]' }, windowExpiresAt: null })).toBe('placeholder_unresolved');
  });

  it('always explains itself in a sentence the owner can act on', () => {
    const result = run({ windowExpiresAt: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(20);
  });
});
