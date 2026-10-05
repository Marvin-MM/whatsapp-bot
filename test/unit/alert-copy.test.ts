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

describe('alerts that point somewhere useful', () => {
  it('sends the owner to the page that has the thing to do', async () => {
    const { alertPath, alertText } = await import('@/lib/notify/alert-copy');
    expect(alertPath('task_overdue')).toBe('/tasks');
    expect(alertPath('draft_generation_failed')).toBe('/approvals');
    expect(alertPath('window_expiring')).toBe('/conversations?filter=needs_reply');
    expect(alertPath('whatsapp_token_invalid')).toBe('/settings');
    expect(alertPath('something_new')).toBe('/settings');
    const text = alertText({ kind: 'task_overdue', severity: 'warning' }, 'https://x.example/tasks');
    expect(text).toContain('A task is overdue');
    expect(text).toContain('https://x.example/tasks');
    // an alert carries a kind and an id only: never the task's words, a name or a number
    expect(text).not.toMatch(/\d{6,}/);
  });

  it('has plain words for the Phase 4 and 5 alerts', async () => {
    const { alertText } = await import('@/lib/notify/alert-copy');
    for (const kind of ['analysis_failed', 'ai_key_invalid', 'draft_generation_failed']) {
      expect(alertText({ kind, severity: 'warning' }, 'https://x.example'), kind).not.toMatch(/^.?\s?Alert:/);
    }
  });
});
