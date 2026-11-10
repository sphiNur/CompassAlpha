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
});
