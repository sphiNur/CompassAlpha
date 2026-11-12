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
import { SHOULD_RUN } from './helpers/pg';
import { pgErrorOf } from './helpers/errors';

describe.skipIf(!SHOULD_RUN)('event store guards (PG-gated)', () => {
  const fixtures = () => getDb(undefined, { system: 'maintenance' });
  const app = () => getDb();
  const ids = { orgId: randomUUID(), userId: randomUUID(), streamId: randomUUID() };
  const adjustments = (streamId: string, seqs: number[]) =>
    seqs.map((seq) => ({
      orgId: ids.orgId,
      streamType: 'order',
      streamId,
      seq,
      type: 'ItemAdjusted',
      payload: {},
      actorId: ids.userId,
    }));

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
    // Every test may try to change these three; none may succeed.
    await db.insert(s.events).values(adjustments(ids.streamId, [1, 2, 3]));
  });

  afterAll(async () => {
    const db = fixtures();
    await db.delete(s.organizations).where(eq(s.organizations.id, ids.orgId));
    await db.delete(s.users).where(eq(s.users.id, ids.userId));
  });

  const countEvents = async (streamId = ids.streamId) =>
    (
      await fixtures()
        .select({ id: s.events.id })
        .from(s.events)
        .where(eq(s.events.streamId, streamId))
    ).length;

  test('D1: the app cannot update, delete or truncate events', async () => {
    const update = await pgErrorOf(() =>
      withOrgContext(app(), ids.orgId, (tx) =>
        tx
          .update(s.events)
          .set({ payload: { forged: true } })
          .where(eq(s.events.streamId, ids.streamId)),
      ),
    );
    expect(update?.message).toContain('append-only');
    const del = await pgErrorOf(() =>
      withOrgContext(app(), ids.orgId, (tx) =>
        tx.delete(s.events).where(eq(s.events.streamId, ids.streamId)),
      ),
    );
    expect(del?.message).toContain('append-only');
    const truncate = await pgErrorOf(() =>
      withSystemContext(app(), 'maintenance', (tx) =>
        tx.execute(sql`TRUNCATE domain.events CASCADE`),
      ),
    );
    expect(truncate?.message).toContain('append-only');
    expect(await countEvents()).toBe(3);
  });

  test('D1: a purge may delete, still not update', async () => {
    // A stream of the test's own: deleting from the shared one changed the
    // count the other tests read (review NEW-RAND-01).
    const streamId = randomUUID();
    await fixtures()
      .insert(s.events)
      .values(adjustments(streamId, [1, 2, 3]));
    const update = await pgErrorOf(() =>
      withOrgContext(app(), ids.orgId, async (tx) => {
        await allowEventPurge(tx);
        await tx.update(s.events).set({ payload: {} }).where(eq(s.events.streamId, streamId));
      }),
    );
    expect(update?.message).toContain('append-only');
    await withOrgContext(app(), ids.orgId, async (tx) => {
      await allowEventPurge(tx);
      await tx.delete(s.events).where(and(eq(s.events.streamId, streamId), eq(s.events.seq, 3)));
    });
    expect(await countEvents(streamId)).toBe(2);
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
      const err = await pgErrorOf(async () => {
        await conn`DELETE FROM domain.events WHERE stream_id = ${ids.streamId}`;
      });
      await conn`ROLLBACK`;
      expect(err?.message).toContain('append-only');
    } finally {
      conn.release();
    }
    expect(await countEvents()).toBe(3);
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
    const byHand = await pgErrorOf(() =>
      withSystemContext(app(), 'maintenance', (tx) =>
        tx.update(s.events).set({ actorId: null }).where(eq(s.events.streamId, streamId)),
      ),
    );
    expect(byHand?.message).toContain('append-only');
    await db.delete(s.users).where(eq(s.users.id, other!.id));
    const [row] = await db.select().from(s.events).where(eq(s.events.streamId, streamId));
    expect(row?.actorId).toBeNull();
  });

  /** With no tenant and app.system_context set to `reason`: what
   *  app_is_system() says, and how many of the shared stream's events show. */
  const seen = (reason: string) =>
    withOrgContext(app(), null, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.system_context', ${reason}, true)`);
      const rows = (await tx.execute(
        sql`SELECT app_is_system() AS system, count(*)::int AS n FROM domain.events WHERE stream_id = ${ids.streamId}`,
      )) as unknown as Array<{ system: boolean; n: number }>;
      return rows[0]!;
    });

  test('D3: app_is_system() accepts each SystemReason and nothing else', async () => {
    // packages/db checks that the migration lists exactly these; this is
    // what a database migrated from it does with them (review TEST1-16).
    for (const reason of SYSTEM_REASONS) {
      expect({ reason, system: (await seen(reason)).system }).toEqual({ reason, system: true });
    }
    for (const reason of ['anything-i-like', 'Worker', '']) {
      expect({ reason, system: (await seen(reason)).system }).toEqual({ reason, system: false });
    }
  });

  test("D3: a made-up system context sees no tenant's rows; a real one sees them all", async () => {
    expect(await seen('anything-i-like')).toEqual({ system: false, n: 0 });
    expect(await seen('worker')).toEqual({ system: true, n: 3 });
  });
});
