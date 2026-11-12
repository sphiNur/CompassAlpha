import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sheetDragCloses } from '../components/Sheet';

/** Review UI-25: the sheet's drag handle drags. */
describe('sheetDragCloses', () => {
  const height = 600;

  test('pulled past a quarter of the sheet closes it', () => {
    expect(sheetDragCloses(150, 0, height)).toBe(true);
    expect(sheetDragCloses(400, 0, height)).toBe(true);
  });

  test('a shorter, slow pull springs back', () => {
    expect(sheetDragCloses(149, 0, height)).toBe(false);
    expect(sheetDragCloses(80, 0.2, height)).toBe(false);
  });

  test('a flick down closes from a short pull, but a tap does not', () => {
    expect(sheetDragCloses(40, 0.8, height)).toBe(true);
    expect(sheetDragCloses(10, 2, height)).toBe(false);
    expect(sheetDragCloses(0, 0, height)).toBe(false);
  });

  test('pushed up, or moving up when let go, is no close', () => {
    expect(sheetDragCloses(-50, 1, height)).toBe(false);
    expect(sheetDragCloses(40, -0.8, height)).toBe(false);
  });

  test('the slide out starts where the finger let go', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'tokens.css'), 'utf8');
    const slideDown = /@keyframes slideDown \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(slideDown).toContain('from {\n    transform: translateY(var(--sheet-drag, 0px));');
  });
});
