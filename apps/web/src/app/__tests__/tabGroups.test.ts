/**
 * Owner 2026-11-23: ordering and receiving, buying and its history, each
 * take one place in the bar (app/shell/tabGroups.ts).
 */
import { describe, expect, test } from 'bun:test';
import type { CatalogKey } from '@compass/i18n';
import type { Tab } from '../../stores/navStore';
import { navLayout } from '../shell/navLayout';
import {
  entryKeyFor,
  groupBadge,
  groupEntries,
  memberToOpen,
  membersAround,
} from '../shell/tabGroups';

const tab = (key: Tab) => ({
  key,
  labelKey: `nav.${key}` as CatalogKey,
  shortKey: `nav.short.${key}` as CatalogKey,
});
const tabs = (...keys: Tab[]) => keys.map(tab);

describe('groupEntries', () => {
  test('a manager with every page fits the bar: two groups, no More', () => {
    const entries = groupEntries(
      tabs('order', 'approve', 'run', 'confirm', 'settlement', 'history', 'attendance'),
    );
    expect(entries.map((e) => e.key)).toEqual([
      'order',
      'approve',
      'run',
      'settlement',
      'attendance',
    ]);
    expect(entries[0]).toMatchObject({
      members: ['order', 'confirm'],
      labelKey: 'nav.group.orders',
      shortKey: 'nav.short.group.orders',
    });
    // Buying keeps its own words: the group is buying, now and before.
    expect(entries[2]).toMatchObject({ members: ['run', 'history'], labelKey: 'nav.run' });
    const layout = navLayout(entries, ['run.purchase']);
    expect(layout.more).toEqual([]);
  });

  test('store staff: ordering and receiving are one item', () => {
    const entries = groupEntries(tabs('order', 'confirm', 'attendance'));
    expect(entries.map((e) => [e.key, e.members])).toEqual([
      ['order', ['order', 'confirm']],
      ['attendance', undefined],
    ]);
  });

  test('one visible member is no group: the tab stands alone under its own name', () => {
    // A store manager without run.purchase: History, not Buying.
    const entries = groupEntries(tabs('order', 'confirm', 'history', 'settlement'));
    const history = entries.find((e) => e.key === 'history');
    expect(history).toEqual(tab('history'));
    // Receiving without ordering (a receiver only) is Receiving.
    expect(groupEntries(tabs('confirm'))).toEqual([tab('confirm')]);
  });
});

describe('the open tab and its entry', () => {
  const entries = groupEntries(tabs('order', 'confirm', 'run', 'history', 'settlement'));
  test('a member is shown in the bar by its group', () => {
    expect(entryKeyFor('confirm', entries)).toBe('order');
    expect(entryKeyFor('history', entries)).toBe('run');
    expect(entryKeyFor('settlement', entries)).toBe('settlement');
  });
  test('the switch lists the members of the open group only', () => {
    expect(membersAround('confirm', entries)).toEqual(['order', 'confirm']);
    expect(membersAround('settlement', entries)).toEqual([]);
  });
});

describe('memberToOpen', () => {
  const members: Tab[] = ['order', 'confirm'];
  test('the member last open, or the first', () => {
    expect(memberToOpen(members, undefined, {})).toBe('order');
    expect(memberToOpen(members, 'confirm', {})).toBe('confirm');
    expect(memberToOpen(members, 'run', {})).toBe('order');
  });
  test('goods to receive take the store to Receiving', () => {
    expect(memberToOpen(members, 'order', { confirm: 3 })).toBe('confirm');
  });
  test('unless the member last open has something waiting too', () => {
    expect(memberToOpen(['run', 'history'], 'run', { run: 1 })).toBe('run');
  });
});

describe('groupBadge', () => {
  test('counts add up; a dot only when no member has a count', () => {
    expect(groupBadge({ order: 2, confirm: 3 }, ['order', 'confirm'])).toBe(5);
    expect(groupBadge({ confirm: 'dot' }, ['order', 'confirm'])).toBe('dot');
    expect(groupBadge({ confirm: 'dot', order: 1 }, ['order', 'confirm'])).toBe(1);
    expect(groupBadge({ settlement: 4 }, ['order', 'confirm'])).toBeUndefined();
  });
});
