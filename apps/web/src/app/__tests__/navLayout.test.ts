import { describe, expect, test } from 'bun:test';
import { BUILTIN_ROLES } from '@compass/db/seed-data';
import type { Tab } from '../../stores/navStore';
import { MAX_BAR_ITEMS, navLayout } from '../shell/navLayout';
import { visibleTabsFor } from '../shell/tabs';

/** A built-in role's permissions, plus any switched on per member. */
function perms(slug: string, extra: readonly string[] = []): string[] {
  const role = BUILTIN_ROLES.find((r) => r.slug === slug);
  if (!role) throw new Error(`no role ${slug}`);
  return [...role.permissions, ...extra];
}

/** The bar and More for a member holding `permissions` in every store. */
function layoutFor(permissions: readonly string[]) {
  const tabs = visibleTabsFor(permissions, permissions, false);
  const { bar, more } = navLayout(tabs, permissions);
  return { bar: bar.map((t) => t.key), more: more.map((t) => t.key) };
}

const keys = (...k: Tab[]) => k.map((key) => ({ key }));

describe('the bottom bar holds at most five items (owner, 2026-11-14)', () => {
  test('owner / org admin (clocking in too): review, buying, close and admin; the rest in More', () => {
    expect(layoutFor(perms('admin', ['attendance.clock']))).toEqual({
      bar: ['approve', 'run', 'settlement', 'admin'],
      more: ['order', 'confirm', 'history', 'attendance'],
    });
    expect(layoutFor(perms('super_admin'))).toEqual({
      bar: ['approve', 'run', 'settlement', 'admin'],
      more: ['order', 'confirm', 'history'],
    });
  });

  test("store manager: the store's daily work; history and admin in More", () => {
    expect(layoutFor(perms('manager'))).toEqual({
      bar: ['order', 'approve', 'settlement', 'confirm'],
      more: ['history', 'admin'],
    });
  });

  test('roles with five tabs or fewer keep them all, in the canonical order', () => {
    for (const slug of ['purchaser', 'cashier', 'staff']) {
      const p = perms(slug);
      const tabs = visibleTabsFor(p, p, false).map((t) => t.key);
      expect(tabs.length).toBeLessThanOrEqual(MAX_BAR_ITEMS);
      expect(layoutFor(p)).toEqual({ bar: tabs, more: [] });
    }
    // A member who only clocks in.
    expect(layoutFor(['attendance.clock'])).toEqual({ bar: ['attendance'], more: [] });
  });

  test('five tabs fit without More; six put four in the bar', () => {
    const five = keys('order', 'approve', 'history', 'settlement', 'confirm');
    expect(navLayout(five, [])).toEqual({ bar: five, more: [] });
    const six = keys('order', 'approve', 'history', 'settlement', 'confirm', 'admin');
    const { bar, more } = navLayout(six, []);
    expect(bar).toHaveLength(MAX_BAR_ITEMS - 1);
    expect(bar.length + more.length).toBe(six.length);
  });

  test('the bar keeps the canonical order whatever the priority', () => {
    const all = keys(
      'order',
      'approve',
      'run',
      'history',
      'settlement',
      'confirm',
      'attendance',
      'admin',
    );
    const { bar } = navLayout(all, ['org.admin']);
    expect(bar.map((t) => t.key)).toEqual(['approve', 'run', 'settlement', 'admin']);
  });
});
