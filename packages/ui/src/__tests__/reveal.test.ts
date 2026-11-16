/**
 * Owner 2026-11-16: content opens and folds with motion (Reveal), and
 * state colours change over time instead of in one frame.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Reveal } from '../components/Reveal';

const css = readFileSync(join(import.meta.dir, '..', 'tokens.css'), 'utf8');
const draw = (open: boolean) =>
  renderToStaticMarkup(
    createElement(Reveal, { open, id: 'x', children: createElement('p', null, 'rows') }),
  );

describe('Reveal', () => {
  test('draws its children only while open', () => {
    expect(draw(true)).toContain('rows');
    expect(draw(true)).toContain('id="x"');
    expect(draw(false)).toBe('');
  });

  test('enters from a starting style and folds away while closing', () => {
    expect(css).toMatch(/@starting-style\s*\{\s*\.app-reveal\s*\{\s*opacity:\s*0/);
    expect(css).toMatch(/\.app-reveal\[data-closing\]\s*\{\s*opacity:\s*0/);
  });

  test('animates height only where the browser can reach auto, and never under reduced motion', () => {
    expect(css).toMatch(/@supports \(interpolate-size: allow-keywords\)/);
    const motion = css.indexOf('@media (prefers-reduced-motion: no-preference) {\n  .app-reveal');
    expect(motion).toBeGreaterThan(-1);
    expect(css.indexOf('@supports (interpolate-size: allow-keywords)')).toBeGreaterThan(motion);
  });

  test('pressable controls change colour over time', () => {
    const press = /\.press \{([^}]*)\}/.exec(css)![1]!;
    expect(press).toContain('background-color var(--t-quick)');
    expect(press).toContain('color var(--t-quick)');
  });
});
