/**
 * Review UI-15 (2026-11-10): the type scale lives with the components
 * (tailwind.preset.js), and tailwind-merge's list in cn.ts agrees with it.
 * Review UI-34 (2026-11-12): tokens.css keeps no --text-* copy of it.
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

  // Review MWA-10 / MWC-11 (modern-web-guidance: respect-os-text-scale):
  // rem, so the phone's text size reaches them; the same px at a 16px root.
  test('every size is in rem and keeps its px size at the default root', () => {
    const px: Record<string, number> = {
      'old-display': 24,
      'old-h1': 19,
      'old-h2': 15,
      'old-h3': 14,
      'old-body': 13,
      'old-body-sm': 12,
      'old-label': 11,
      'old-meta': 10,
      'old-tiny': 9,
    };
    for (const [name, [size]] of Object.entries(FONT_SIZE_SCALE)) {
      expect({ name, size }).toEqual({ name, size: `${px[name]! / 16}rem` });
    }
  });

  test('tokens.css has no second copy of the sizes to keep in sync', () => {
    expect(css).not.toMatch(/--text-[a-z-]+:/);
  });

  test('tokens.css carries the animations and the scrollbar rule the components use', () => {
    for (const k of ['slideUp', 'slideDown', 'fadeIn', 'fadeOut']) {
      expect(css).toContain(`@keyframes ${k} {`);
    }
    expect(css).toContain('.scrollbar-hide {');
  });
});
