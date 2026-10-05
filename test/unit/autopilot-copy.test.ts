import { describe, expect, it } from 'vitest';
import { callbackData, parseCallbackData, retiredText, scheduledText, telegramName, waitText } from '@/lib/autopilot/copy';
import { type Digest, digestActive, digestText } from '@/lib/autopilot/digest';

const ID = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

describe('the buttons\' data', () => {
  it('round-trips both actions, and fits in Telegram\'s 64 bytes', () => {
    for (const action of ['cancel', 'send'] as const) {
      const data = callbackData(action, ID);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallbackData(data)).toEqual({ action, draftId: ID });
    }
  });

  it.each([
    '',
    'cancel',
    `ap:delete:${ID}`,
    `ap:cancel:${ID}x`,
    `ap:cancel:${ID.toUpperCase()}`,
    `AP:cancel:${ID}`,
    `ap:cancel:${ID}\nap:send:${ID}`,
    `ap:cancel:../../${ID}`,
    'ap:cancel:not-a-uuid',
    ` ap:cancel:${ID}`,
  ])('refuses %j (anything that is not exactly one of our two actions on a draft id)', (data) => {
    expect(parseCallbackData(data)).toBeNull();
  });
});

describe('who the message names', () => {
  it('prefers a name, then a handle, then the last four digits of the number, then "a customer"', () => {
    const base = { displayName: null, username: null, phoneE164: null, bsuid: null };
    expect(telegramName({ ...base, displayName: '  Amina K  ', username: 'amina', phoneE164: '+256700123456' })).toBe('Amina K');
    expect(telegramName({ ...base, username: 'amina', phoneE164: '+256700123456' })).toBe('@amina');
    expect(telegramName({ ...base, phoneE164: '+256700123456' })).toBe('****3456');
    expect(telegramName({ ...base, bsuid: 'UG.123' })).toBe('a customer');
    expect(telegramName({ ...base, displayName: 'x'.repeat(200) })).toHaveLength(60);
  });
});

describe('the autopilot message', () => {
  it('names the customer, shows the reply and the wait in plain words', () => {
    const text = scheduledText({ name: 'Amina', reply: 'We close at 6pm 🙏', delaySeconds: 120 });
    expect(text).toContain('Autopilot will reply to Amina in 2 minutes');
    expect(text).toContain('We close at 6pm 🙏');
    expect(text).toContain('Cancel');
    expect(waitText(45)).toBe('45 seconds');
    expect(waitText(119)).toBe('119 seconds');
    expect(waitText(300)).toBe('5 minutes');
  });

  it('cuts a very long reply instead of exceeding Telegram\'s limit', () => {
    expect(scheduledText({ name: 'A', reply: 'x'.repeat(5000), delaySeconds: 60 }).length).toBeLessThan(1700);
  });

  it('after the fact it keeps the reply and says how it ended', () => {
    const text = retiredText({ name: 'Amina', reply: 'We close at 6pm', note: 'Sent.' });
    expect(text).toBe('🤖 Sent.\nAmina\n\nWe close at 6pm');
  });
});

const digest = (over: Partial<Digest> = {}): Digest => ({ sent: 0, cancelled: 0, routed: 0, silent: 0, demoted: 0, markedBad: 0, topReasons: [], ...over });

describe('the daily digest', () => {
  it('counts what happened, in words, with the top reasons and a link', () => {
    const text = digestText(digest({ sent: 4, cancelled: 1, routed: 3, silent: 2, demoted: 1, markedBad: 1, topReasons: [{ reason: 'quiet_hours', count: 2 }, { reason: 'risk_flags', count: 1 }] }), 'https://x.test/settings/autopilot');
    expect(text).toContain('Sent automatically: 4');
    expect(text).toContain('Cancelled by you: 1');
    expect(text).toContain('Handed to your approval instead: 3');
    expect(text).toContain('Conversations taken off autopilot: 1');
    expect(text).toContain('Replies you marked bad: 1');
    expect(text).toContain('Why they came to you: Quiet hours (2); The draft carries a risk flag (1)');
    expect(text.endsWith('https://x.test/settings/autopilot')).toBe(true);
  });

  it('leaves out lines that would only say zero, except the three headline counts', () => {
    const text = digestText(digest(), 'https://x.test');
    expect(text).toContain('Sent automatically: 0');
    expect(text).not.toContain('taken off autopilot');
    expect(text).not.toContain('marked bad');
    expect(text).not.toContain('Why they came');
  });

  it('is "active" when anything happened', () => {
    expect(digestActive(digest())).toBe(false);
    for (const key of ['sent', 'cancelled', 'routed', 'silent', 'demoted', 'markedBad'] as const) expect(digestActive(digest({ [key]: 1 }))).toBe(true);
  });

  it('a reason code it does not know is shown as words, not hidden', () => {
    expect(digestText(digest({ topReasons: [{ reason: 'some_new_reason', count: 1 }] }), 'x')).toContain('some new reason (1)');
  });
});
