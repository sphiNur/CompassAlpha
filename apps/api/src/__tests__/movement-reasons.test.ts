/**
 * Review ADM2-34 (2026-11-12): the reasons a stock movement is booked
 * under are MOVEMENT_REASONS in @compass/contracts/limits; the stores
 * screen labels them from that list and shows any other reason raw. This
 * reads the reasons the API and the worker write where they book movements
 * (`reason: '…'` and `…_REASON = '…'` in a file that inserts into
 * inventoryMovements) and checks each is in the list. A reason written in
 * raw SQL is not read.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOVEMENT_REASONS } from '@compass/contracts/limits';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('stock movement reasons (ADM2-34)', () => {
  test('every reason a movement is booked under is in MOVEMENT_REASONS', () => {
    const written = new Set<string>();
    for (const file of ['apps/api/src', 'apps/worker/src'].flatMap((d) => sources(join(ROOT, d)))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('insert(s.inventoryMovements)')) continue;
      for (const m of text.matchAll(/\breason: '([a-z_]+)'|_REASON = '([a-z_]+)'/g)) {
        written.add((m[1] ?? m[2])!);
      }
    }
    // The scan still finds the writes of the stores screen's own procedures.
    expect(written.has('stocktake') && written.has('wastage')).toBe(true);
    const known = new Set<string>(MOVEMENT_REASONS);
    expect([...written].filter((reason) => !known.has(reason))).toEqual([]);
  });
});
