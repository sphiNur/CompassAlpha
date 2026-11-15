/**
 * Owner, 2026-11-15: no app top bar. The top is room for Telegram's
 * chrome (or the device's safe area in a browser): no store chip, no
 * settings button, no title. 2026-11-16: the page scrolls under it, so it
 * is an inset and a veil, not a strip.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopVeil, topInset } from '../shell/TopBar';

const g = globalThis as { window?: unknown };
const before = g.window;

afterEach(() => {
  g.window = before;
});

function inTelegram(yes: boolean) {
  g.window = {
    Telegram: {
      WebApp: { initData: yes ? 'query_id=x&user=%7B%7D&hash=y' : '' },
    },
  };
}

describe('the top of the screen', () => {
  test('inside Telegram: room under its chrome', () => {
    inTelegram(true);
    expect(topInset()).toContain('--app-chrome-reserve');
  });
  test('in a browser: the safe area only', () => {
    inTelegram(false);
    expect(topInset()).toBe('var(--app-safe-top)');
  });
  test('the veil holds nothing and takes no taps', () => {
    const html = renderToStaticMarkup(createElement(TopVeil));
    expect(html).toContain('app-top-veil');
    expect(html).toContain('aria-hidden');
    expect(html).not.toMatch(/<button|<header|Compass/);
  });
});
