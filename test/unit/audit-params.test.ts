import { describe, expect, it } from 'vitest';
import { parseAuditParams } from '@/lib/ops/audit-view';

describe('parseAuditParams (the address bar is untrusted)', () => {
  it('reads valid filters', () => {
    expect(parseAuditParams({ action: 'task.create', entity: 'task', actor: 'owner', from: '2026-09-29', to: '2026-10-05', cursor: 'abc' })).toEqual({
      filters: { action: 'task.create', entity: 'task', actor: 'owner', from: '2026-09-29', to: '2026-10-05' },
      cursor: 'abc',
    });
  });

  it('drops what is malformed instead of failing: bad dates, unknown actors, empty and over-long values', () => {
    const { filters } = parseAuditParams({ from: '2026-02-30', to: 'yesterday', actor: 'root', action: '', entity: 'x'.repeat(200) });
    expect(filters).toEqual({ action: null, entity: null, actor: null, from: null, to: null });
  });

  it('takes the first of a repeated parameter, and trims', () => {
    expect(parseAuditParams({ action: ['  a.b  ', 'c.d'] }).filters.action).toBe('a.b');
  });

  it('caps the cursor length', () => {
    expect(parseAuditParams({ cursor: 'x'.repeat(1000) }).cursor).toHaveLength(400);
  });

  it('accepts a leap day and refuses a non-leap one', () => {
    expect(parseAuditParams({ from: '2028-02-29' }).filters.from).toBe('2028-02-29');
    expect(parseAuditParams({ from: '2026-02-29' }).filters.from).toBeNull();
  });
});
