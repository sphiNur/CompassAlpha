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
 * the left, the button on the right as a circle in a capsule of the nav's
 * glass, 8px between and at the ends.
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
  const rule = (selector: string) => {
    const at = appCss.indexOf(`${selector} {`);
    return at < 0 ? '' : appCss.slice(at, appCss.indexOf('}', at));
  };

  test('an icon-only tab still taps as 44 px', () => {
    expect(remPx('--app-nav-icon-w')).toBeGreaterThanOrEqual(44);
    expect(rule('  [data-main-button] .app-dock[data-nav] .app-nav-item')).toMatch(
      /min-width: 44px;/,
    );
  });

  test("the circle is the open tab's pill height, its capsule the nav's height", () => {
    // The pill is inset 4px top and bottom in the capsule (inset-y-1).
    expect(navSrc).toMatch(/app-nav-active absolute inset-x-0\.5 inset-y-1 /);
    expect(appCss).toContain(`--app-main-btn-d: calc(${light['--app-nav-h']} - 8px);`);
    const btn = rule('  .app-main-btn');
    expect(btn).toMatch(/width: var\(--app-main-btn-d\);/);
    expect(btn).toMatch(/height: var\(--app-main-btn-d\);/);
    expect(btn).toMatch(/min-width: 44px;/);
    expect(btn).toMatch(/min-height: 44px;/);
    expect(rule('  .app-main-capsule')).toMatch(/padding: 4px;/);
    expect(buttonSrc).toMatch(
      /app-main-btn press relative flex items-center justify-center rounded-full/,
    );
  });

  test("the circle's capsule has the nav capsule's glass", () => {
    const nav = rule('  .app-nav::before');
    const capsule = rule('  .app-main-capsule');
    for (const part of [
      'background: var(--c-nav-surface-solid);',
      'var(--shadow-nav),\n      inset 0 0 0 1px var(--c-divider);',
    ]) {
      expect(nav).toContain(part);
      expect(capsule).toContain(part);
    }
    expect(rule('  .app-main-capsule')).toMatch(/border-radius: var\(--r-pill\);/);
    // The blur, and solid under reduced transparency, as the nav.
    expect(appCss).toMatch(
      /\.app-nav::before,\s*\.app-main-capsule,\s*\.app-dock-hint \{\s*background: var\(--c-nav-surface\);\s*-webkit-backdrop-filter/,
    );
    expect(appCss).toMatch(
      /\.app-nav::before,\s*\.app-main-capsule,\s*\.app-dock-hint \{\s*background: var\(--c-nav-surface-solid\);\s*-webkit-backdrop-filter: none/,
    );
  });

  test('the row fits a 320 px phone with five tabs, so it never stacks', () => {
    const gap = remPx('--app-dock-gap');
    const capsule = 5 * 44 + 2 * 4; // the tabs at their tap, padding-inline: 4px
    const circle = 60 - 8 + 2 * 4;
    expect(gap).toBe(8);
    expect(320 - 2 * gap - capsule - gap - circle).toBeGreaterThanOrEqual(0);
    expect(appCss).not.toMatch(/@container|container:/);
    expect(appCss).not.toMatch(/column-reverse/);
  });

  test('no words on it: they are its accessible name and title', () => {
    expect(buttonSrc).toMatch(/aria-label=\{state\.text\}/);
    expect(buttonSrc).toMatch(/title=\{state\.text\}/);
    expect(buttonSrc).not.toMatch(/>\s*\{state\.text\}\s*</);
  });

  test("a count is a badge with the nav badges' look", () => {
    expect(buttonSrc).toMatch(/\$\{NAV_BADGE_COUNT_CLASS\}/);
    expect(navSrc).toMatch(/\$\{NAV_BADGE_COUNT_CLASS\}/);
  });

  test('icons only: the labels go, every tab keeps its name', () => {
    expect(rule('  [data-main-button] .app-dock[data-nav] .app-nav-label')).toMatch(
      /display: none;/,
    );
    // Each NavItem is given an aria-label (the full name, with its badge).
    expect(navSrc).toMatch(/aria-label=\{ariaLabel\}/);
    expect(navSrc).not.toMatch(/ariaLabel=\{undefined\}/);
  });

  test('scrolling down neither hides tabs nor shrinks the capsule beside the button', () => {
    expect(appCss).not.toMatch(/\.app-nav-item:not\(\[aria-current\]\)/);
    expect(appCss).toMatch(
      /\[data-main-button\] \[data-nav-compact\] \.app-dock\[data-nav\] \.app-nav::before,[^{]*\{\s*transform: none;/,
    );
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
