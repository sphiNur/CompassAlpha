/**
 * Owner 2026-11-16: every tap gets feedback. The default press state in
 * styles/index.css covers every tappable element, so a new button gets
 * it without anyone remembering a class; and iOS only shows :active with
 * a touchstart listener on the document (main.tsx).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dir, '..', '..');
const css = readFileSync(join(src, 'styles', 'index.css'), 'utf8');
const main = readFileSync(join(src, 'main.tsx'), 'utf8');
const pressRule = /:where\(([^)]*)\):where\(\s*:not\(([^)]*)\)\s*\):active\s*\{([^}]*)\}/.exec(css);

describe('tap feedback', () => {
  test('there is one default press state', () => {
    expect(pressRule).not.toBeNull();
    expect(pressRule![3]).toMatch(/opacity:\s*0\.6/);
  });

  test('it covers every kind of tappable element', () => {
    const targets = pressRule![1]!;
    for (const t of [
      'button',
      'a[href]',
      'summary',
      "[role='button']",
      "[role='tab']",
      "[role='radio']",
      "[role='checkbox']",
      "[role='switch']",
      "[role='option']",
    ])
      expect(targets).toContain(t);
  });

  test('disabled controls do not react, and controls with their own press look keep it', () => {
    const not = pressRule![2]!;
    for (const t of [
      ':disabled',
      "[aria-disabled='true']",
      "[class*='active:bg-']",
      "[class*='active:opacity']",
    ])
      expect(not).toContain(t);
  });

  test('it lives in the base layer at zero specificity, so a component can override it', () => {
    const base = css.indexOf('@layer base');
    const end = css.indexOf('\n}\n', base);
    const at = css.indexOf(pressRule![0]);
    expect(at).toBeGreaterThan(base);
    expect(at).toBeLessThan(end);
  });

  test('iOS shows :active: a lasting touchstart listener on the document', () => {
    expect(main).toMatch(
      /document\.addEventListener\('touchstart', \(\) => \{\}, \{ passive: true \}\)/,
    );
  });
});
