import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// BUY-9 (2026-10-30): the client only sends X-Idempotency-Key for routes
// in IDEMPOTENT_MUTATIONS. Two server-side idempotent routes were missing,
// so their dedupe never ran. Read both sides as text (importing trpc.ts
// pulls in the browser client) and require the list to cover the server.
const ROUTERS = join(import.meta.dir, '../../../../api/src/trpc/routers');
const CLIENT = join(import.meta.dir, '../trpc.ts');

function serverIdempotentRoutes(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(ROUTERS)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const router = file.replace(/\.ts$/, '');
    const src = readFileSync(join(ROUTERS, file), 'utf8');
    for (const m of src.matchAll(/^ {2}(\w+): idempotentMutation\b/gm)) {
      out.push(`${router}.${m[1]}`);
    }
  }
  return out.sort();
}

function clientList(): Set<string> {
  const src = readFileSync(CLIENT, 'utf8');
  const block = src.slice(src.indexOf('IDEMPOTENT_MUTATIONS = new Set'));
  const body = block.slice(0, block.indexOf(']);'));
  return new Set([...body.matchAll(/'([a-z]+\.[A-Za-z]+)'/g)].map((m) => m[1]!));
}

describe('IDEMPOTENT_MUTATIONS', () => {
  test('lists every route the server declares idempotentMutation', () => {
    const server = serverIdempotentRoutes();
    expect(server.length).toBeGreaterThan(5);
    const client = clientList();
    expect(server.filter((route) => !client.has(route))).toEqual([]);
  });
});
