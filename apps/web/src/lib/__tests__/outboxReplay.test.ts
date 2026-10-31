import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPLAYED_PROCEDURES } from '../outboxReplay';

/** Every `.ts`/`.tsx` file under src, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('outbox replay (CMP-FE-3)', () => {
  test('every procedure a page queues has an app-level replay handler', () => {
    const src = join(import.meta.dir, '..', '..');
    const queued = new Set<string>();
    for (const file of sources(src)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\b(?:enqueue|sendQueued)\(\s*'([a-zA-Z]+\.[a-zA-Z]+)'/g)) {
        queued.add(m[1]!);
      }
    }
    expect(queued.size).toBeGreaterThan(0);
    for (const procedure of queued) {
      expect(REPLAYED_PROCEDURES as readonly string[]).toContain(procedure);
    }
  });
});
