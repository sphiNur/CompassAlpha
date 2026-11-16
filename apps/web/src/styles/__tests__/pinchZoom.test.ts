/** Owner 2026-11-16: pinch zoom allowed; iOS never zooms into a field. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readFileSync(join(import.meta.dir, '..', '..', '..', 'index.html'), 'utf8');
const css = readFileSync(join(import.meta.dir, '..', 'index.css'), 'utf8');

test('the viewport does not lock the scale', () => {
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? '';
  expect(viewport).toContain('width=device-width');
  expect(viewport).not.toMatch(/user-scalable|maximum-scale/);
});

test('on iOS every text field is at least 16px, so focus does not zoom', () => {
  expect(css).toMatch(
    /@supports \(-webkit-touch-callout: none\) \{[^}]*textarea,\s*select \{\s*font-size: max\(16px, 1rem\) !important;/,
  );
});
