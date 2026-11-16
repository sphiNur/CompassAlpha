/** MWG delta audit (2026-11-16): the until-found list survives being emptied and refilled. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '..', 'FindableWhenShut.tsx'), 'utf8');

describe('FindableWhenShut', () => {
  test('sets until-found again whenever the list is drawn anew', () => {
    expect(src).toMatch(/\}, \[drawn\]\);/);
    expect(src).not.toMatch(/\}, \[\]\);/);
  });
});
