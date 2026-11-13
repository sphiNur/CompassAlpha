import { describe, expect, test } from 'bun:test';
import { pageTitle } from '../pageTitle';

describe('pageTitle (A11Y-10)', () => {
  test('page, store, app — empty parts dropped', () => {
    expect(pageTitle(['下单', 'Central Kitchen'])).toBe('下单 · Central Kitchen · Compass');
    expect(pageTitle(['商品', null, '管理', ' '])).toBe('商品 · 管理 · Compass');
    expect(pageTitle([])).toBe('Compass');
  });
});
