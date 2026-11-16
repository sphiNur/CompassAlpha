import { describe, expect, test } from 'bun:test';
import { BUILTIN_ROLES } from '@compass/db/seed-data';
import type { Tab } from '../../stores/navStore';
import { MAX_BAR_TABS, navLayout } from '../shell/navLayout';
import { visibleTabsFor } from '../shell/tabs';

/** A built-in role's permissions, plus any switched on per member. */
function perms(slug: string, extra: readonly string[] = []): string[] {
  const role = BUILTIN_ROLES.find((r) => r.slug === slug);
  if (!role) throw new Error(`no role ${slug}`);
  return [...role.permissions, ...extra];
}

/** The bar, the More page's rows and whether Admin is there, for a member. */
function layoutFor(permissions: readonly string[]) {
  const tabs = visibleTabsFor(permissions, permissions, false);
  const { bar, more, admin, morePage } = navLayout(tabs, permissions);
  return {
    bar: bar.map((t) => t.key),
    more: more.map((t) => t.key),
    admin: admin !== null,
    morePage,
  };
}

const keys = (...k: Tab[]) => k.map((key) => ({ key }));

describe('owner 2026-11-17: Admin on the More page, ordering and clock-in in the bar', () => {
  test('admin is never in the bar; it makes a More page', () => {
    expect(layoutFor(perms('manager'))).toEqual({
      bar: ['order', 'approve', 'confirm', 'settlement', 'history'],
      more: [],
      admin: true,
      morePage: true,
    });
  });

  test('owner / org admin: review, buying, the close, then ordering and clock-in', () => {
    expect(layoutFor(perms('admin', ['attendance.clock']))).toEqual({
      bar: ['order', 'approve', 'run', 'settlement', 'attendance'],
      more: ['confirm', 'history'],
      admin: true,
      morePage: true,
    });
    expect(layoutFor(perms('super_admin'))).toEqual({
      bar: ['order', 'approve', 'run', 'confirm', 'settlement'],
      more: ['history'],
      admin: true,
      morePage: true,
    });
  });

  test('a store member keeps ordering and clock-in in the bar', () => {
    expect(layoutFor(perms('staff', ['attendance.clock'])).bar).toEqual([
      'order',
      'confirm',
      'sales',
      'attendance',
    ]);
    expect(layoutFor(perms('purchaser')).bar).toEqual(['run', 'history']);
  });

  test('without Admin and with five tabs or fewer there is no More', () => {
    for (const slug of ['purchaser', 'cashier', 'staff']) {
      const p = perms(slug);
      const tabs = visibleTabsFor(p, p, false).map((t) => t.key);
      expect(tabs.length).toBeLessThanOrEqual(MAX_BAR_TABS);
      expect(layoutFor(p)).toEqual({ bar: tabs, more: [], admin: false, morePage: false });
    }
  });

  test('six tabs put five in the bar and one on the More page', () => {
    const six = keys('order', 'approve', 'history', 'settlement', 'confirm', 'attendance');
    const { bar, more, morePage } = navLayout(six, []);
    expect(bar).toHaveLength(MAX_BAR_TABS);
    expect(more).toHaveLength(1);
    expect(morePage).toBe(true);
  });

  test('the bar keeps the canonical order whatever the priority', () => {
    const all = keys('order', 'approve', 'run', 'history', 'settlement', 'confirm', 'attendance');
    const { bar } = navLayout(all, ['org.admin']);
    expect(bar.map((t) => t.key)).toEqual(['order', 'approve', 'run', 'settlement', 'attendance']);
  });
});

describe('in a browser there is always a More page, for Settings (owner, 2026-11-15)', () => {
  test('even when every tab fits', () => {
    const four = keys('order', 'approve', 'confirm', 'settlement');
    expect(navLayout(four, [], true)).toEqual({ bar: four, more: [], admin: null, morePage: true });
  });
});
