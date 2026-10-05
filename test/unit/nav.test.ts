import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, badgeFor, formatBadge, isActivePath } from '@/components/shared/nav-items';

describe('navigation (spec section 12)', () => {
  it('has every dashboard destination the spec lists, once each', () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      '/',
      '/approvals',
      '/conversations',
      '/tasks',
      '/style',
      '/analytics',
      '/settings',
    ]);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((item) => item.label)).size).toBe(NAV_ITEMS.length);
  });

  it('puts the four daily destinations in the mobile tab bar and the rest under "More"', () => {
    const primary = NAV_ITEMS.filter((item) => item.primary).map((item) => item.href);
    expect(primary).toEqual(['/', '/approvals', '/conversations', '/tasks']);
  });
});

describe('isActivePath', () => {
  it('matches the overview only on the exact root', () => {
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/approvals', '/')).toBe(false);
  });

  it('matches a section and its sub-routes', () => {
    expect(isActivePath('/conversations', '/conversations')).toBe(true);
    expect(isActivePath('/conversations/0190abcd', '/conversations')).toBe(true);
  });

  it('does not confuse sections that share a prefix', () => {
    expect(isActivePath('/tasks-archive', '/tasks')).toBe(false);
    expect(isActivePath('/style', '/settings')).toBe(false);
  });
});

describe('nav badges', () => {
  it('shows nothing for zero, missing, negative or non-finite counts, and the count otherwise', () => {
    expect(badgeFor(undefined, '/approvals')).toBe(0);
    expect(badgeFor({}, '/approvals')).toBe(0);
    expect(badgeFor({ '/approvals': 0 }, '/approvals')).toBe(0);
    expect(badgeFor({ '/approvals': -3 }, '/approvals')).toBe(0);
    expect(badgeFor({ '/approvals': Number.NaN }, '/approvals')).toBe(0);
    expect(badgeFor({ '/approvals': 4 }, '/approvals')).toBe(4);
    expect(badgeFor({ '/approvals': 4 }, '/tasks')).toBe(0);
  });

  it('caps the label so the badge keeps its width', () => {
    expect(formatBadge(7)).toBe('7');
    expect(formatBadge(99)).toBe('99');
    expect(formatBadge(100)).toBe('99+');
  });
});
