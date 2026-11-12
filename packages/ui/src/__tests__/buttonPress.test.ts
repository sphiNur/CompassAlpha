import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../components/Button';

/**
 * Review UI-31: a utility transition on Button replaced .press's
 * `transition: transform`, so the press shrink jumped instead of easing.
 */
describe('Button press', () => {
  test('transitions transform at the press timing, with its colours', () => {
    const html = renderToStaticMarkup(createElement(Button, null, 'Save'));
    const cls = /class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(cls).toContain('press');
    expect(cls).toContain('transition-[background,color,box-shadow,transform]');
    expect(cls).toContain('duration-[var(--t-snap)]');
    expect(cls).toContain('ease-[var(--easing)]');
  });
});
