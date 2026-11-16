/** MWG delta audit (2026-11-16, color): toasts keep an edge in a contrast theme. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the forced-colors block outlines toasts and their buttons', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'tokens.css'), 'utf8');
  const block = css.slice(css.indexOf('@media (forced-colors: active)'));
  expect(block).toMatch(
    /\[data-toast\],\s*\[data-toast\] button \{\s*outline: 1px solid CanvasText/,
  );
});
