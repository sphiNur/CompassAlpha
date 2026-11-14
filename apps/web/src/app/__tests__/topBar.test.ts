/**
 * Owner, 2026-11-15: no app top bar. The top is an empty strip for
 * Telegram's chrome (or the device's safe area in a browser): no store
 * chip, no settings button, no title.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopBar } from '../shell/TopBar';

const g = globalThis as { window?: unknown };
const before = g.window;

afterEach(() => {
  g.window = before;
});

function draw(inTelegram: boolean): string {
  g.window = {
    Telegram: {
      WebApp: { initData: inTelegram ? 'query_id=x&user=%7B%7D&hash=y' : '' },
    },
  };
  return renderToStaticMarkup(createElement(TopBar));
}

describe('the top of the screen', () => {
  test('inside Telegram: the strip under its chrome, nothing in it', () => {
    const html = draw(true);
    expect(html).toContain('--app-chrome-reserve');
    expect(html).not.toMatch(/<button|Compass/);
  });
  test('in a browser: the safe area only, nothing in it', () => {
    const html = draw(false);
    expect(html).toContain('height:var(--app-safe-top)');
    expect(html).not.toMatch(/<button|<header|Compass/);
  });
});
