import { describe, expect, it } from 'vitest';
import { alertText } from '@/lib/notify/alert-copy';

describe('alertText', () => {
  it('says what happened and what to do, with the link, and nothing else', () => {
    const text = alertText({ kind: 'whatsapp_token_invalid', severity: 'critical' }, 'https://app.example/settings');
    expect(text).toContain('🔴');
    expect(text).toMatch(/access token rejected/i);
    expect(text).toContain('https://app.example/settings');
  });

  it('still gives an unknown kind a readable line (kinds are machine names, never customer content)', () => {
    expect(alertText({ kind: 'something_new_happened', severity: 'warning' }, 'https://x/settings')).toBe('🟠 Alert: something new happened\nhttps://x/settings');
  });

  it('has copy for every alert kind the send path and the scans can raise', () => {
    for (const kind of ['whatsapp_token_invalid', 'whatsapp_spam_restricted', 'whatsapp_account_locked', 'message_unknown', 'window_expiring', 'token_check_failed']) {
      expect(alertText({ kind, severity: 'warning' }, 'l')).not.toMatch(/^.. Alert:/);
    }
  });
});
