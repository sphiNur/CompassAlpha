import { describe, expect, test } from 'bun:test';
import { announce, announcementText, subscribeAnnouncements } from '../announce';
import { pageTitle } from '../pageTitle';

describe('announce (A11Y-12)', () => {
  test('a message reaches the subscribed region', () => {
    const heard: string[] = [];
    const off = subscribeAnnouncements((t) => heard.push(t));
    announce('3 products found');
    off();
    announce('not heard');
    expect(heard.map((t) => t.trim())).toEqual(['3 products found']);
  });

  test('the same message twice still changes the region text', () => {
    const heard: string[] = [];
    const off = subscribeAnnouncements((t) => heard.push(t));
    announce('No matches');
    announce('No matches');
    off();
    expect(heard[0]).not.toBe(heard[1]);
    expect(heard.map((t) => t.trim())).toEqual(['No matches', 'No matches']);
  });

  test('blank messages say nothing', () => {
    const heard: string[] = [];
    const off = subscribeAnnouncements((t) => heard.push(t));
    announce('   ');
    announce(null);
    off();
    expect(heard).toEqual([]);
  });

  test('announcementText alternates a trailing no-break space', () => {
    expect(announcementText('x', 1)).toBe('x');
    expect(announcementText('x', 2)).toBe('x\u00a0');
  });
});

describe('pageTitle (A11Y-10)', () => {
  test('page, store, app — empty parts dropped', () => {
    expect(pageTitle(['下单', 'Central Kitchen'])).toBe('下单 · Central Kitchen · Compass');
    expect(pageTitle(['商品', null, '管理', ' '])).toBe('商品 · 管理 · Compass');
    expect(pageTitle([])).toBe('Compass');
  });
});
