/**
 * The event store at the database (2026-10-30 re-review of 12-工程.md):
 *   - D1: the application role could UPDATE, DELETE and TRUNCATE
 *     domain.events. Migration 0055 makes the table refuse all three,
 *     except a purge that says so for its own transaction
 *     (allowEventPurge) and the existing foreign-key cascades.
 *   - D3: app_is_system() accepted any non-empty app.system_context, so
 *     set_config('app.system_context', 'anything', true) read every
 *     tenant. Only the SystemReason values count now.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/event-store-guard.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  allowEventPurge,
  getDb,
  schema as s,
  SYSTEM_REASONS,
  unprobed,
  withOrgContext,
  withSystemContext,
} from '@compass/db';

const HERE = dirname(fileURLToPath(import.meta.url));

(function loadEnv() {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

describe('D3: the database and the code agree on the system reasons', () => {
  test('app_is_system() lists exactly SYSTEM_REASONS', () => {
    const policies = readFileSync(
      resolve(HERE, '../../../../packages/db/migrations/sql/900_rls_policies.sql'),
      'utf8',
    );
    const body = /FUNCTION app_is_system\(\)[\s\S]*?IN \(([^)]*)\)/.exec(policies);
    expect(body).toBeTruthy();
    const listed = [...body![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...SYSTEM_REASONS].sort());
  });
});

async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    const e = err as { message: string; cause?: { message?: string } };
    return `${e.message} ${e.cause?.message ?? ''}`;
  }
}

describe.skipIf(!SHOULD_RUN)('event store guards (PG-gated)', () => {
  const fixtures = () => getDb(undefined, { system: 'maintenance' });
  const app = () => getDb();
  const ids = { orgId: randomUUID(), userId: randomUUID(), streamId: randomUUID() };

  beforeAll(async () => {
    const db = fixtures();
    await db.insert(s.organizations).values({
      id: ids.orgId,
      slug: `event-guard-${ids.orgId}`,
      name: 'Event guard',
      localeDefault: 'en',
      timezone: 'UTC',
    });
    await db.insert(s.users).values({ id: ids.userId, displayName: 'Event guard actor' });
    await db.insert(s.events).values(
      [1, 2, 3].map((seq) => ({
        orgId: ids.orgId,
        streamType: 'order',
        streamId: ids.streamId,
        seq,
        type: 'ItemAdjusted',
        payload: {},
        actorId: ids.userId,
      })),
    );
  });

  afterAll(async () => {
    const db = fixtures();
    await db.delete(s.organizations).where(eq(s.organizations.id, ids.orgId));
    await db.delete(s.users).where(eq(s.users.id, ids.userId));
  });

  const countEvents = async () =>
    (
      await fixtures()
        .select({ id: s.events.id })
        .from(s.events)
        .where(eq(s.events.streamId, ids.streamId))
    ).length;

  test('D1: the app cannot update, delete or truncate events', async () => {
    const update = await errorOf(() =>
      withOrgContext(app(), ids.orgId, (tx) =>
        tx
          .update(s.events)
          .set({ payload: { forged: true } })
          .where(eq(s.events.streamId, ids.streamId)),
      ),
    );
    expect(update).toContain('append-only');
    const del = await errorOf(() =>
      withOrgContext(app(), ids.orgId, (tx) =>
        tx.delete(s.events).where(eq(s.events.streamId, ids.streamId)),
      ),
    );
    expect(del).toContain('append-only');
    const truncate = await errorOf(() =>
      withSystemContext(app(), 'maintenance', (tx) =>
        tx.execute(sql`TRUNCATE domain.events CASCADE`),
      ),
    );
    expect(truncate).toContain('append-only');
    expect(await countEvents()).toBe(3);
  });

  test('D1: a purge may delete, still not update', async () => {
    const update = await errorOf(() =>
      withOrgContext(app(), ids.orgId, async (tx) => {
        await allowEventPurge(tx);
        await tx.update(s.events).set({ payload: {} }).where(eq(s.events.streamId, ids.streamId));
      }),
    );
    expect(update).toContain('append-only');
    await withOrgContext(app(), ids.orgId, async (tx) => {
      await allowEventPurge(tx);
      await tx
        .delete(s.events)
        .where(and(eq(s.events.streamId, ids.streamId), eq(s.events.seq, 3)));
    });
    expect(await countEvents()).toBe(2);
  });

  test('D1: the purge permission ends with its transaction', async () => {
    // One connection, so the second transaction is on the same session.
    const conn = await unprobed(app()).$client.reserve();
    try {
      await conn`BEGIN`;
      await conn`SELECT set_config('app.current_org_id', ${ids.orgId}, true)`;
      await conn`SELECT set_config('app.event_purge', 'on', true)`;
      await conn`COMMIT`;
      await conn`BEGIN`;
      await conn`SELECT set_config('app.current_org_id', ${ids.orgId}, true)`;
      const err = await errorOf(async () => {
        await conn`DELETE FROM domain.events WHERE stream_id = ${ids.streamId}`;
      });
      await conn`ROLLBACK`;
      expect(err).toContain('append-only');
    } finally {
      conn.release();
    }
    expect(await countEvents()).toBe(2);
  });

  test('D1: deleting a user still clears actor_id on their events', async () => {
    const db = fixtures();
    const [other] = await db.insert(s.users).values({ displayName: 'Leaves' }).returning();
    const streamId = randomUUID();
    await db.insert(s.events).values({
      orgId: ids.orgId,
      streamType: 'order',
      streamId,
      seq: 1,
      type: 'ItemAdjusted',
      payload: {},
      actorId: other!.id,
    });
    // Setting it by hand is refused while the user exists.
    const byHand = await errorOf(() =>
      withSystemContext(app(), 'maintenance', (tx) =>
        tx.update(s.events).set({ actorId: null }).where(eq(s.events.streamId, streamId)),
      ),
    );
    expect(byHand).toContain('append-only');
    await db.delete(s.users).where(eq(s.users.id, other!.id));
    const [row] = await db.select().from(s.events).where(eq(s.events.streamId, streamId));
    expect(row?.actorId).toBeNull();
  });

  test('D3: a made-up system context sees nothing; a real one sees all tenants', async () => {
    const seen = (reason: string) =>
      withOrgContext(app(), null, async (tx) => {
        await tx.execute(sql`SELECT set_config('app.system_context', ${reason}, true)`);
        const rows = (await tx.execute(
          sql`SELECT app_is_system() AS system, count(*)::int AS n FROM domain.events WHERE stream_id = ${ids.streamId}`,
        )) as unknown as Array<{ system: boolean; n: number }>;
        return rows[0]!;
      });
    expect(await seen('anything-i-like')).toEqual({ system: false, n: 0 });
    expect(await seen('worker')).toEqual({ system: true, n: 2 });
  });
});
