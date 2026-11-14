import { describe, expect, test } from 'bun:test';
import { mainButtonSaysBusy } from '../shell/PageMainButton';

/**
 * Review MWB-10 (modern-web-guidance: progress): the page's main button
 * says "Please wait…" when its own press started the write, not for a
 * write started anywhere else in the app.
 */
describe('mainButtonSaysBusy', () => {
  test('after its press, or while it has focus', () => {
    expect(mainButtonSaysBusy(true, 0, 10_000)).toBe(true);
    expect(mainButtonSaysBusy(false, 9_500, 10_000)).toBe(true);
  });

  test('not for a write from elsewhere', () => {
    expect(mainButtonSaysBusy(false, 0, 10_000)).toBe(false);
    expect(mainButtonSaysBusy(false, 5_000, 10_000)).toBe(false);
  });
});
