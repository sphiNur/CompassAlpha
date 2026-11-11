/**
 * Review TEST3-06 (2026-11-10): the procedures built from
 * `idempotentMutation` are exactly the shared list the web client sends
 * an idempotency key for (@compass/contracts/idempotency). A route the
 * server declares but the client leaves out is never deduplicated (the
 * middleware does nothing without a key); one the client lists but the
 * server does not is sent a key nobody reads.
 *
 * The web test this replaces read the router files as text, with a
 * pattern that depended on their indentation; this reads the router.
 */
import { describe, expect, test } from 'bun:test';
import { IDEMPOTENT_ROUTES } from '@compass/contracts/idempotency';
import { appRouter } from '../router';
import type { ProcedureMeta } from '../trpc';

type Procedures = Record<string, { _def: { type: string; meta?: ProcedureMeta } }>;

describe('idempotent routes (TEST3-06)', () => {
  const procedures = (appRouter._def as unknown as { procedures: Procedures }).procedures;

  test('the router is read: it has many procedures, some of them idempotent', () => {
    expect(Object.keys(procedures).length).toBeGreaterThan(50);
    expect(procedures['run.purchaseItem']?._def.meta?.idempotent).toBe(true);
    expect(procedures['admin.memberList']?._def.meta?.idempotent).toBeUndefined();
  });

  test('the routers declare idempotentMutation on exactly the shared list', () => {
    const declared = Object.entries(procedures)
      .filter(([, p]) => p._def.meta?.idempotent === true)
      .map(([path]) => path)
      .sort();
    expect(declared).toEqual([...IDEMPOTENT_ROUTES].sort());
  });

  test('every listed route is a mutation, listed once', () => {
    expect(new Set(IDEMPOTENT_ROUTES).size).toBe(IDEMPOTENT_ROUTES.length);
    for (const route of IDEMPOTENT_ROUTES) {
      expect({ route, type: procedures[route]?._def.type }).toEqual({ route, type: 'mutation' });
    }
  });
});
