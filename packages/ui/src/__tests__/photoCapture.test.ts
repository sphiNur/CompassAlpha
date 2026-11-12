import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PhotoCapture } from '../components/PhotoCapture';

/** Review UI-29. */
describe('PhotoCapture', () => {
  test('no decorative camera emoji: the hint says it (UI-1)', () => {
    const html = renderToStaticMarkup(createElement(PhotoCapture, { onCapture: () => {} }));
    expect(html).not.toContain('📷');
  });

  test('the remove button over the photo takes its colours from tokens (UI-8)', () => {
    const html = renderToStaticMarkup(
      createElement(PhotoCapture, {
        onCapture: () => {},
        onClear: () => {},
        value: 'data:image/jpeg;base64,AAAA',
      }),
    );
    expect(html).toContain('bg-[var(--c-overlay-control)] text-[var(--c-overlay-control-fg)]');
    expect(html).not.toContain('oklch(');
    expect(html).not.toContain('text-white');
  });
});
