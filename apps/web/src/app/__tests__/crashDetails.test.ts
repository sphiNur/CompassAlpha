import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ErrorBoundary, crashDetails } from '../ErrorBoundary';

/** DX-SHL-16: the trace is copied for the administrator, not shown to staff. */
describe('crash screen', () => {
  test('the copied details carry the message and the top of the stack', () => {
    const error = new Error('boom');
    error.stack = ['Error: boom', ...Array.from({ length: 20 }, (_, i) => `  at f${i}`)].join('\n');
    const text = crashDetails(error);
    expect(text).toContain('boom');
    expect(text).toContain('at f6');
    expect(text).not.toContain('at f7');
  });

  // Review TEST3-06 (2026-11): this read ErrorBoundary.tsx and looked for
  // "<pre"; a trace drawn any other way passed. It now draws the screen.
  test('the screen shows neither the message nor the trace', () => {
    const g = globalThis as { window?: unknown };
    const before = g.window;
    // The crash screen picks its language from storage and Telegram.
    g.window = {
      localStorage: { getItem: () => null },
      Telegram: { WebApp: { initDataUnsafe: { user: { language_code: 'en' } } } },
    };
    try {
      const error = new Error('boom-message');
      error.stack = 'Error: boom-message\n  at secretFrame (app.js:1:1)';
      const boundary = new ErrorBoundary({ children: null });
      boundary.state = { error };
      const html = renderToStaticMarkup(boundary.render() as ReactElement);
      expect(html).toContain('<button');
      expect(html).not.toContain('boom-message');
      expect(html).not.toContain('secretFrame');
      expect(html).not.toContain('<pre');
    } finally {
      g.window = before;
    }
  });

  // Review COREWEB1-23 / COREWEB1-25 (2026-11-11).
  test('no warning glyph, and button colours from the theme', () => {
    const g = globalThis as { window?: unknown };
    const before = g.window;
    g.window = { localStorage: { getItem: () => null } };
    try {
      const boundary = new ErrorBoundary({ children: null });
      boundary.state = { error: new Error('x') };
      const html = renderToStaticMarkup(boundary.render() as ReactElement);
      expect(html).not.toContain('⚠');
      // White text on the dark theme's light-blue action colour was 2.4:1.
      expect(html).toContain('color:var(--c-action-fg, white)');
      expect(html).not.toContain('color:white');
      // A black hairline vanished on the dark theme.
      expect(html).toContain('border:1px solid var(--c-divider');
    } finally {
      g.window = before;
    }
  });
});
