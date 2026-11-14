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
