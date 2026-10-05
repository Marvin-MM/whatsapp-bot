import { describe, expect, it } from 'vitest';
import { auditEntityHref, describeMetadata } from '@/lib/ops/audit-present';

const ID = '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

describe('auditEntityHref', () => {
  it('links the entities that have a page', () => {
    expect(auditEntityHref('conversation', ID)).toBe(`/conversations/${ID}`);
    expect(auditEntityHref('task', ID)).toBe(`/tasks#task-${ID}`);
    expect(auditEntityHref('draft', ID)).toBe(`/approvals?d=${ID}`);
  });

  it('does not link anything else, or an id that is not a uuid (it would be put in a URL)', () => {
    expect(auditEntityHref('message', ID)).toBeNull();
    expect(auditEntityHref('job', 'download-media/media-1')).toBeNull();
    expect(auditEntityHref('task', '../../etc/passwd')).toBeNull();
    expect(auditEntityHref('conversation', `${ID}/../x`)).toBeNull();
    expect(auditEntityHref('task', '')).toBeNull();
  });
});

describe('describeMetadata', () => {
  it('reads as key: value, skips empties, joins lists, and shortens long values', () => {
    expect(describeMetadata({ via: 'analysis', changed: ['description', 'dueAt'], none: null, empty: '', n: 3, flag: false })).toEqual(['via: analysis', 'changed: description, dueAt', 'n: 3', 'flag: false']);
    const long = describeMetadata({ x: 'y'.repeat(200) });
    expect(long[0]?.length).toBeLessThanOrEqual(63);
    expect(long[0]?.endsWith('…')).toBe(true);
  });

  it('shows nested objects as JSON and at most eight entries', () => {
    expect(describeMetadata({ nested: { a: 1 } })).toEqual(['nested: {"a":1}']);
    expect(describeMetadata(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i + 1])))).toHaveLength(8);
  });
});
