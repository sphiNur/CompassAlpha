/**
 * Plan 2.2 (2026-11-23, migration 0074): a bot message the worker gave up
 * on was closed exactly like a delivered one, so nothing counted it.
 * system.health now reports how many were given up in the last 24 hours,
 * and leaves `status` alone (the deploy smoke requires `ok`).
 *
 * Counts are compared before and after, since other tests share the
 * database and its outbox.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/outbox-health.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';

const inserted: string[] = [];

afterAll(async () => {
  if (!SHOULD_RUN || inserted.length === 0) return;
  await getDb(undefined, { system: 'maintenance' })
    .delete(s.outbox)
    .where(inArray(s.outbox.id, inserted));
});

async function closedRow(failure: string | null, closedHoursAgo: number): Promise<void> {
  const at = new Date(Date.now() - closedHoursAgo * 3_600_000);
  const [row] = await getDb(undefined, { system: 'maintenance' })
    .insert(s.outbox)
    .values({
      aggregate: 'notification',
      aggregateId: randomUUID(),
      eventId: randomUUID(),
      channel: 'bot',
      payload: {},
      sentAt: at,
      createdAt: at,
      ...(failure ? { failedAt: at, failure } : {}),
    })
    .returning({ id: s.outbox.id });
  inserted.push(row!.id);
}

describe.skipIf(!SHOULD_RUN)('system.health and given-up bot messages (PG-gated)', () => {
  test('counts the ones given up in the last 24 hours, and only those', async () => {
    const health = () => callerFor(null).system.health();
    const before = await health();

    await closedRow('gave_up', 1);
    await closedRow('gave_up', 23);
    await closedRow('gave_up', 25); // older than a day
    await closedRow('refused', 1); // the user blocked the bot: routine
    await closedRow(null, 1); // delivered

    const after = await health();
    expect(after.outboxGaveUp24h - before.outboxGaveUp24h).toBe(2);
    // Closed rows are not pending, delivered or not.
    expect(after.outboxPending).toBe(before.outboxPending);
    expect(after.status).toBe(before.status);
  });
});
