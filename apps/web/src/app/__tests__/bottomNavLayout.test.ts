/**
 * The floating nav capsule's sizes (owner, 2026-11-14; WALK-03): every
 * item taps as at least 44 px, also while the capsule is shrunk.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { themeOf } from '@compass/ui/testing/tokenCss';

const light = themeOf({ 'data-theme': 'native' });
// Review MWA-10: --app-nav-h is max(60px, …) so it grows with the text;
// its first term is the size at the default root.
const px = (name: string) => Number.parseFloat((light[name] ?? 'NaN').replace(/^max\(/, ''));
const navSrc = readFileSync(join(import.meta.dir, '..', 'shell', 'BottomNav.tsx'), 'utf8');
const appCss = readFileSync(join(import.meta.dir, '..', '..', 'styles', 'index.css'), 'utf8');

describe('WALK-03: the bottom nav taps as 44', () => {
  test('the capsule, full or shrunk, is at least 44 px tall', () => {
    expect(px('--app-nav-h')).toBeGreaterThanOrEqual(44);
    expect(px('--app-nav-h-compact')).toBeGreaterThanOrEqual(44);
  });

  test('the capsule grows with larger text, never below 60 px (MWA-10)', () => {
    expect(light['--app-nav-h']).toBe('max(60px, calc(46px + 0.875rem))');
  });

  test('each item fills the capsule height and is at least min(44 px, a fifth) wide', () => {
    const item = /function NavItem[\s\S]*?className=\{\s*'([^']*)'/.exec(navSrc)![1]!;
    expect(item).toContain('min-w-[min(2.75rem,20%)]');
    expect(item).not.toMatch(/\bh-\d|overflow-hidden|\btruncate\b/);
    // The capsule has no vertical padding, so the items are its height.
    const rule = /\.app-nav\s*\{([^}]*)\}/.exec(appCss)![1]!;
    expect(rule).not.toMatch(/padding(-block|-top|-bottom)?\s*:/);
  });

  test('the rows of the More sheet are at least 44 px tall', () => {
    expect(navSrc).toMatch(/press flex min-h-12 w-full/);
  });
});

describe('Review MWC-14 (V10): the capsule shrinks with transforms only', () => {
  const rule = (selector: string) => {
    const at = appCss.indexOf(`${selector} {`);
    return at < 0 ? '' : appCss.slice(at, appCss.indexOf('}', at));
  };

  test('its height is not animated, and stays put when compact', () => {
    expect(rule('  .app-nav')).not.toMatch(/transition:[^;]*\bheight\b/);
    expect(appCss).not.toMatch(/\[data-nav-compact\] \.app-nav \{\s*height/);
  });

  test('the compact scales are the 48-of-60 capsule and the 40-of-52 pill', () => {
    const scale = (name: string) =>
      Number(new RegExp(`${name}: ([\\d.]+);`).exec(appCss)?.[1] ?? 'NaN');
    expect(scale('--app-nav-compact-scale')).toBeCloseTo(
      px('--app-nav-h-compact') / px('--app-nav-h'),
      2,
    );
    expect(scale('--app-nav-compact-pill-scale')).toBeCloseTo(
      (px('--app-nav-h-compact') - 8) / (px('--app-nav-h') - 8),
      2,
    );
  });
});

/**
 * Owner, 2026-11-14: on a page with a main button, the button and the
 * capsule share one row (the dock, Shell.tsx / index.css): icons only on
 * the left, the button on the right, 8px between and at the ends.
 */
describe('the main button on the nav row', () => {
  const shellSrc = readFileSync(join(import.meta.dir, '..', 'Shell.tsx'), 'utf8');
  const buttonSrc = readFileSync(
    join(import.meta.dir, '..', 'shell', 'PageMainButton.tsx'),
    'utf8',
  );
  const remPx = (name: string) => {
    const m = new RegExp(`${name}: ([\\d.]+)(px|rem)`).exec(appCss)!;
    // eslint-disable-next-line no-restricted-syntax -- CSS lengths, not money
    return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  };
  const row = /@container app-dock \(min-width: ([\d.]+)rem\) \{([\s\S]*?)\n {2}\}/.exec(appCss)!;

  test('an icon-only tab still taps as 44 px', () => {
    expect(remPx('--app-nav-icon-w')).toBeGreaterThanOrEqual(44);
    expect(row[2]).toMatch(/\.app-nav-item \{[^}]*width: var\(--app-nav-icon-w\)/);
  });

  test('the button keeps room for a two-line label on a 360 px phone with five tabs', () => {
    const gap = remPx('--app-dock-gap');
    const icon = remPx('--app-nav-icon-w');
    const capsule = 5 * icon + 2 * 4; // padding-inline: 4px
    const at = (vw: number) => vw - 2 * gap - capsule - gap;
    expect(gap).toBe(8);
    // The row starts where a 360 px phone's dock is (360 − 2 × 8).
    expect(Number(row[1]) * 16).toBeLessThanOrEqual(360 - 2 * gap);
    expect(at(360)).toBe(108);
    expect(at(390)).toBe(138);
    expect(at(430)).toBe(178);
    // Scrolled down, the capsule is the open tab alone.
    expect(360 - 2 * gap - (icon + 8) - gap).toBe(284);
  });

  test('the button is the capsule height and its label stays at two lines', () => {
    expect(row[2]).toMatch(/\.app-main-btn \{[^}]*min-height: var\(--app-nav-h\)/);
    expect(buttonSrc).toMatch(/app-main-btn-label[^"]*line-clamp-2/);
  });

  test('icons only: the labels go, every tab keeps its name', () => {
    expect(row[2]).toMatch(/\.app-nav-label \{\s*display: none;/);
    // Each NavItem is given an aria-label (the full name, with its badge).
    expect(navSrc).toMatch(/aria-label=\{ariaLabel\}/);
    expect(navSrc).not.toMatch(/ariaLabel=\{undefined\}/);
  });

  test('scrolling down keeps the open tab, unless focus is in the nav', () => {
    expect(row[2]).toMatch(
      /\[data-nav-compact\][^{]*\.app-nav:not\(:focus-within\)\s+\.app-nav-item:not\(\[aria-current\]\)\s*\{\s*display: none;/,
    );
  });

  test('no width or height is animated; the motion is off under reduced motion', () => {
    expect(appCss).not.toMatch(/transition:[^;]*\b(width|height|max-width|flex)\b/);
    for (const m of appCss.matchAll(
      /@keyframes (app-nav-to-front|app-dock-in-[ab]) \{([\s\S]*?)\n {2}\}/g,
    )) {
      expect(m[2]).not.toMatch(/\b(width|height|left|right|flex)\s*:/);
    }
    const motion = appCss.indexOf('animation: app-nav-to-front');
    const guard = appCss.lastIndexOf('@media (prefers-reduced-motion: no-preference)', motion);
    expect(guard).toBeGreaterThan(-1);
  });

  test('the page keeps room for the dock, not for two bars', () => {
    expect(appCss).toContain(
      'padding-bottom: calc(var(--app-nav-reserve) + var(--app-main-btn-h, 0px));',
    );
    expect(appCss).not.toMatch(/\[data-main-button\] \.app-main \{/);
  });

  test('the nav comes first for Tab, and the dock is outside the swipe pager', () => {
    const dock = shellSrc.indexOf('className="app-dock"');
    expect(dock).toBeGreaterThan(shellSrc.indexOf('</SwipePager>'));
    expect(shellSrc.indexOf('<BottomNav', dock)).toBeLessThan(
      shellSrc.indexOf('<PageMainButton', dock),
    );
  });
});
