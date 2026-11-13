/**
 * UX-09 (2026-11-14): inside Telegram the top bar has its own way into
 * the settings sheet (and the page's menu actions); before, only
 * Telegram's gear in its ⋯ menu opened it.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadCatalog } from '@compass/i18n';
import { TopBar } from '../shell/TopBar';

const g = globalThis as { window?: unknown };
const before = g.window;

beforeAll(async () => {
  await loadCatalog('en');
});

afterEach(() => {
  g.window = before;
});

function draw(inTelegram: boolean): string {
  g.window = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { language: 'en' },
    Telegram: {
      WebApp: {
        initData: inTelegram ? 'query_id=x&user=%7B%7D&hash=y' : '',
        initDataUnsafe: { user: { language_code: 'en' } },
      },
    },
  };
  return renderToStaticMarkup(createElement(TopBar, { onOpenSettings: () => {} }));
}

const settingsButtons = (html: string) =>
  [...html.matchAll(/<button[^>]*data-testid="open-settings"[^>]*>/g)].map((m) => m[0]);

describe('the top bar opens settings', () => {
  test('inside Telegram: one button, named Settings, tapped as 44 px', () => {
    const buttons = settingsButtons(draw(true));
    expect(buttons).toHaveLength(1);
    const button = buttons[0]!;
    expect(button).toContain('aria-label="Settings"');
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toContain('hit-44');
  });

  test('inside Telegram it keeps clear of Close and ⋯', () => {
    const html = draw(true);
    expect(html).toContain('padding-left:max(var(--app-chrome-pad-left, 16px)');
    expect(html).toContain('padding-right:max(var(--app-chrome-pad-right, 16px)');
  });

  test('in a browser: still the one button with the org name', () => {
    expect(settingsButtons(draw(false))).toHaveLength(1);
  });
});
