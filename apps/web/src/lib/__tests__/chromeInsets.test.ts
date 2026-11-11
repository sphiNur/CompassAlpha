import { describe, expect, test } from 'bun:test';
import { chromeInsets } from '../chromeInsets';

const inset = (top: number, left = 0, right = 0) => ({ top, bottom: 0, left, right });

describe('chromeInsets (M3.42 / M3.46 / M3.47)', () => {
  test('Android with the content inset: the inset, at least the safe area and the 56 px row', () => {
    const tg = { platform: 'android', safeAreaInset: inset(24), contentSafeAreaInset: inset(80) };
    expect(chromeInsets(tg)).toEqual({ safeTop: 24, reserve: 80, padLeft: 56, padRight: 96 });
    expect(chromeInsets({ ...tg, contentSafeAreaInset: inset(60) }).reserve).toBe(80);
  });

  test('iOS under-reporting the content inset: the 64 px row floor wins', () => {
    const tg = { platform: 'ios', safeAreaInset: inset(47), contentSafeAreaInset: inset(50) };
    expect(chromeInsets(tg).reserve).toBe(111);
  });

  test('only the safe area reported: it plus the row', () => {
    expect(chromeInsets({ platform: 'ios', safeAreaInset: inset(20) }).reserve).toBe(84);
    expect(chromeInsets({ platform: 'android', safeAreaInset: inset(0) }).reserve).toBe(56);
  });

  test('nothing reported: no reserve, so the stylesheet decides', () => {
    expect(chromeInsets({})).toEqual({ safeTop: 0, reserve: null, padLeft: 56, padRight: 96 });
  });

  test('Telegram Desktop has no buttons over the page', () => {
    const tg = { platform: 'tdesktop', safeAreaInset: inset(0), contentSafeAreaInset: inset(0) };
    expect(chromeInsets(tg)).toEqual({ safeTop: 0, reserve: 0, padLeft: 0, padRight: 0 });
  });

  test('the side widths Telegram reports win over the defaults', () => {
    const tg = {
      platform: 'ios',
      safeAreaInset: inset(47),
      contentSafeAreaInset: inset(100, 44, 88),
    };
    expect(chromeInsets(tg)).toMatchObject({ padLeft: 44, padRight: 88 });
  });
});
