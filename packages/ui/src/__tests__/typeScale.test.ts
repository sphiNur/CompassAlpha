/**
 * Review UI-15 (2026-11-10): the type scale lives with the components
 * (tailwind.preset.js), and the two other places that name its sizes
 * agree with it: tailwind-merge's list in cn.ts and the --text-* vars in
 * tokens.css.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import preset, { FONT_SIZE_SCALE } from '../../tailwind.preset.js';
import { cn } from '../cn';

const names = Object.keys(FONT_SIZE_SCALE);
const css = readFileSync(join(import.meta.dir, '..', 'tokens.css'), 'utf8');

describe('type scale (UI-15)', () => {
  test('the preset adds the scale to the theme', () => {
    expect(preset.theme.extend.fontSize).toBe(FONT_SIZE_SCALE);
    expect(names).toContain('old-body');
  });

  test('cn knows every size: a later size replaces an earlier one, a colour does not', () => {
    for (const name of names) {
      expect(cn('text-old-tiny', `text-${name}`)).toBe(`text-${name}`);
      expect(cn(`text-${name}`, 'text-white')).toBe(`text-${name} text-white`);
    }
  });

  test('each size matches its --text-* var in tokens.css', () => {
    for (const [name, [size]] of Object.entries(FONT_SIZE_SCALE)) {
      const v = new RegExp(`--text-${name.replace(/^old-/, '')}:\\s*([^;]+);`).exec(css);
      expect(v?.[1]?.trim()).toBe(size);
    }
  });

  test('tokens.css carries the animations and the scrollbar rule the components use', () => {
    for (const k of ['slideUp', 'slideDown', 'fadeIn', 'fadeOut']) {
      expect(css).toContain(`@keyframes ${k} {`);
    }
    expect(css).toContain('.scrollbar-hide {');
  });
});
