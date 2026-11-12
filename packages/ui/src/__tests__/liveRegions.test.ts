import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Banner, bannerRole } from '../components/Banner';
import { ToastProvider, toastLiveness } from '../components/Toast';

/** Review UI-22: what the banners and the toast stack say to a screen reader. */
describe('Banner role', () => {
  test('a danger banner is an alert; the other tones are a status', () => {
    expect(bannerRole('danger')).toBe('alert');
    for (const tone of ['info', 'success', 'warn'] as const) {
      expect(bannerRole(tone)).toBe('status');
    }
    const html = renderToStaticMarkup(
      createElement(Banner, { tone: 'danger', title: 'Could not load' }),
    );
    expect(html).toMatch(/^<div role="alert"/);
    expect(renderToStaticMarkup(createElement(Banner, { title: 'How it works' }))).toMatch(
      /^<div role="status"/,
    );
  });

  test("the caller's role wins (a standing warning is a note)", () => {
    const html = renderToStaticMarkup(
      createElement(Banner, { tone: 'danger', role: 'note', title: 'Wipe everything' }),
    );
    expect(html).toMatch(/^<div role="note"/);
  });
});

describe('Toast live regions', () => {
  test('an error interrupts, anything else waits', () => {
    expect(toastLiveness('danger')).toBe('assertive');
    for (const tone of ['info', 'success', 'warn'] as const) {
      expect(toastLiveness(tone)).toBe('polite');
    }
  });

  test('both regions are on the page before any toast, and neither rereads the stack', () => {
    const html = renderToStaticMarkup(
      createElement(ToastProvider, { children: createElement('main') }),
    );
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-live="polite"');
    // aria-atomic made each new toast read the whole stack again, and a
    // toast's own role="status" was a second region inside the first.
    expect(html).not.toContain('aria-atomic');
    expect(html).not.toContain('role="status"');
  });
});
