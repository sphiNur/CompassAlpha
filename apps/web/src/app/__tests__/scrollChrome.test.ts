import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '../shell/scrollChrome.ts'), 'utf8');
const css = readFileSync(join(import.meta.dir, '../../styles/index.css'), 'utf8');

describe('the nav capsule while the page scrolls (owner, 2026-11-15)', () => {
  test('keeps one size and its words: nothing shrinks it any more', () => {
    expect(src).not.toContain('data-nav-compact');
    expect(css).not.toContain('nav-compact');
  });

  test('the fades still follow the scroll', () => {
    expect(src).toContain("'data-scrolled'");
    expect(src).toContain("'data-scroll-end'");
  });
});
