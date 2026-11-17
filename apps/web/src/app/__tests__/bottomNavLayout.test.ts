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
const moreSrc = readFileSync(join(import.meta.dir, '..', 'shell', 'MorePage.tsx'), 'utf8');
const appCss = readFileSync(join(import.meta.dir, '..', '..', 'styles', 'index.css'), 'utf8');

describe('WALK-03: the bottom nav taps as 44', () => {
  test('the capsule, full or shrunk, is at least 44 px tall', () => {
    expect(px('--app-nav-h')).toBeGreaterThanOrEqual(44);
  });

  test('the capsule grows with larger text, never below 60 px (MWA-10)', () => {
    expect(light['--app-nav-h']).toBe('max(60px, calc(46px + 0.875rem))');
  });

  test('each item fills the capsule height and is at least 44 px wide', () => {
    const item = /function NavItem[\s\S]*?className=\{\s*'([^']*)'/.exec(navSrc)![1]!;
    expect(item).toContain('min-w-11');
    expect(item).not.toMatch(/\bh-\d|overflow-hidden|\btruncate\b/);
    // The capsule has no vertical padding, so the items are its height.
    const rule = /\.app-nav\s*\{([^}]*)\}/.exec(appCss)![1]!;
    expect(rule).not.toMatch(/padding(-block|-top|-bottom)?\s*:/);
  });

  test('the rows of the More page are at least 44 px tall', () => {
    expect(moreSrc).toMatch(/press flex min-h-12 w-full/);
  });
});

/**
 * Owner, 2026-11-14: on a page with a main button, the button and the
 * capsule share one row (the dock, Shell.tsx / index.css): the capsule
 * with icons and words on the left, the button on the right as a circle in a capsule of the nav's
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

  test('beside the button the capsule fills the row; only the open item shows its word', () => {
    // Owner 2026-11-17: the open item is icon + word, the others icons, the
    // same with or without the main button.
    expect(appCss).not.toMatch(
      /\[data-main-button\] \.app-dock\[data-nav\] \.app-nav(-item|-label)? \{/,
    );
    expect(rule('  .app-nav')).toMatch(/flex: 1 1 auto;/);
    expect(navSrc).toMatch(/\{active \? \(\s*<span className="app-nav-label/);
  });

  test("the circle is the nav capsule's height (owner, 2026-11-15)", () => {
    expect(appCss).toContain(`--app-main-btn-d: ${light['--app-nav-h']};`);
    const btn = rule('  .app-main-btn');
    expect(btn).toMatch(/width: var\(--app-main-btn-d\);/);
    expect(btn).toMatch(/height: var\(--app-main-btn-d\);/);
    expect(btn).toMatch(/min-width: 44px;/);
    expect(btn).toMatch(/min-height: 44px;/);
    expect(rule('  .app-main-capsule')).not.toMatch(/padding/);
    expect(rule('.app-dock-tool')).not.toMatch(/padding/);
    expect(buttonSrc).toMatch(
      /app-main-btn press relative flex items-center justify-center rounded-full/,
    );
  });

  test('no grey ring round the circle; it carries the nav shadow (owner, 2026-11-15)', () => {
    const capsule = rule('  .app-main-capsule');
    expect(capsule).not.toMatch(/background|box-shadow|border/);
    expect(appCss).not.toMatch(/\.app-main-capsule,/);
    expect(rule('  .app-main-btn')).toMatch(/box-shadow: var\(--shadow-nav\);/);
  });

  test('why it is inactive shows on a tap, for a few seconds, and is always its description', () => {
    expect(buttonSrc).toMatch(/const hasHint = !!hint && hintOpen;/);
    expect(buttonSrc).toMatch(/setTimeout\(\(\) => setHintOpen\(false\), HINT_MS\)/);
    expect(buttonSrc).toMatch(/<span id="page-main-button-hint" className="sr-only">/);
    expect(buttonSrc).toMatch(/aria-describedby=\{hint \? 'page-main-button-hint' : undefined\}/);
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

  test('every tab keeps its name', () => {
    // Each NavItem is given an aria-label (the full name, with its badge).
    expect(navSrc).toMatch(/aria-label=\{ariaLabel\}/);
    expect(navSrc).not.toMatch(/ariaLabel=\{undefined\}/);
    expect(appCss).not.toMatch(/\.app-nav-item:not\(\[aria-current\]\)/);
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

/**
 * Owner 2026-11-16: no ghost of the dock, and the page's edges fade the
 * same during a tab's transition as at rest.
 */
describe('the dock and the edge fades in motion', () => {
  const buttonSrc = readFileSync(
    join(import.meta.dir, '..', 'shell', 'PageMainButton.tsx'),
    'utf8',
  );
  const shellSrc = readFileSync(join(import.meta.dir, '..', 'Shell.tsx'), 'utf8');

  test('the old dock picture is dropped, not cross-faded with the new one', () => {
    expect(appCss).toMatch(/::view-transition-old\(app-dock\)[^{]*\{\s*display:\s*none/);
    expect(appCss).toMatch(/::view-transition-new\(app-dock\)[\s\S]*?\{\s*animation:\s*none/);
  });

  test('the edge fades are their own groups, after the page, so it never covers them', () => {
    expect(appCss).toContain("html[data-vt='tab'] .app-top-veil");
    expect(appCss).toContain("html[data-vt='tab'] .app-fade-bottom");
    const main = shellSrc.indexOf('<main');
    expect(shellSrc.indexOf('<TopVeil />')).toBeGreaterThan(main);
    expect(shellSrc.indexOf('app-fade-bottom')).toBeGreaterThan(main);
  });

  test("the main button's room moves by FLIP, not by animating layout, and a dropped button leaves", () => {
    expect(appCss).not.toMatch(/transition:\s*--app-dock-btn-slot/);
    expect(appCss).not.toMatch(/transition:[^;]*\bleft var/);
    expect(buttonSrc).toMatch(/flipDock\(/);
    expect(appCss).toMatch(/\.app-main-btn\[data-leaving\]/);
    expect(buttonSrc).toMatch(/data-leaving=/);
  });

  test('the page scrolls under the top of the screen, which is not a strip', () => {
    expect(appCss).toMatch(/\.app-main \{[^}]*padding-top: var\(--app-top-inset/);
    expect(shellSrc).not.toContain('<TopBar');
  });
});
