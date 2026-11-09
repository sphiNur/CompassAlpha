import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sourceFiles } from '../../__tests__/helpers/sourceFiles';
import { REPLAYED_PROCEDURES } from '../outboxReplay';

describe('outbox replay (CMP-FE-3)', () => {
  test('every procedure a page queues has an app-level replay handler', () => {
    const queued = new Set<string>();
    for (const file of sourceFiles()) {
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
