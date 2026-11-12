/**
 * Realtime pushes and transactions (2026-10-30 re-review):
 *   - B9: `hub.publish` ran inside the transaction that wrote the change,
 *     so a client could be told "seq 12" and read 11 (shown with a slow
 *     COMMIT: the message arrived while the database still had 11), and
 *     a rolled-back write was announced anyway. Sends now wait for COMMIT.
 *   - APR-12 / B14: the worker released idle claims without telling
 *     anyone, so the reviewer's page kept showing a claim that was gone.
 *     The worker now sends a Postgres NOTIFY, which the API relays.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/realtime-after-commit.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  getDb,
  notifyRealtime,
  parseRealtimeNotice,
  schema as s,
  unprobed,
  withOrgContext,
  withSystemContext,
  type DB,
} from '@compass/db';
import { hub } from '../realtime/hub';
import { relayDatabaseNotices, relayRealtimeNotice } from '../realtime/dbRelay';
import { appRouter } from '../trpc/router';
import { loadSession, type SessionContext } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';
import { seedRoles } from './helpers/fixtures';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';

cleanUpAfterAll();

const HERE = dirname(fileURLToPath(import.meta.url));
type ClaimTimeout = {
  releaseClaimIfExpired: (
    tx: DB,
    stream: 'order' | 'run',
    claim: { id: string; orgId: string },
    timeoutMinutes: number,
  ) => Promise<boolean>;
};
const { releaseClaimIfExpired } = (await import(
  resolve(HERE, '../../../worker/src/claimTimeout.ts')
)) as ClaimTimeout;

/** A fake socket on the hub for `orgId`; collects what it is sent. */
function listen(orgId: string, onMessage?: (m: Record<string, unknown>) => void) {
  const received: Array<Record<string, unknown>> = [];
  const unsubscribe = hub.subscribe(orgId, (data) => {
    const m = JSON.parse(data) as Record<string, unknown>;
    received.push(m);
    onMessage?.(m);
  });
  return { received, unsubscribe };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('database notices', () => {
  test('only our message shapes are relayed', () => {
    expect(parseRealtimeNotice('not json')).toBeNull();
    expect(parseRealtimeNotice(JSON.stringify({ type: 'people.changed', orgId: 'o' }))).toBeNull();
    expect(
      parseRealtimeNotice(JSON.stringify({ type: 'order.changed', orgId: 'o', sessionId: 's' })),
    ).toBeNull();
    const ok = { type: 'run.changed', orgId: 'o', runId: 'r', lastSeq: 4 };
    expect(parseRealtimeNotice(JSON.stringify(ok))).toEqual(ok as never);
  });

  test('a relayed notice reaches the sockets of its org', () => {
    const orgId = randomUUID();
    const sink = listen(orgId);
    try {
      const msg = { type: 'order.changed', orgId, sessionId: randomUUID(), lastSeq: 7 };
      expect(relayRealtimeNotice(JSON.stringify(msg))).toBe(true);
      expect(sink.received).toEqual([msg]);
    } finally {
      sink.unsubscribe();
    }
  });
});

describe.skipIf(!SHOULD_RUN)('realtime after commit (PG-gated)', () => {
  const db = () => getDb(undefined, { system: 'maintenance' });
  const app = () => getDb();
  const orgId = randomUUID();
  let staff: ReturnType<typeof appRouter.createCaller>;
  let storeId = '';
  let skuId = '';
  let claimerMemberId = '';
  let claimerUserId = '';
  let stopRelay: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    await db()
      .insert(s.organizations)
      .values({
        id: orgId,
        slug: `realtime-${suffix}`,
        name: 'Realtime',
        localeDefault: 'en',
        timezone: 'UTC',
      });
    noteOrg(orgId);
    const roleId = (await seedRoles(db(), orgId, ['staff'])).staff!;
    const [store] = await db()
      .insert(s.stores)
      .values({ orgId, name: 'Store', code: `RT-${suffix.slice(-6)}` })
      .returning();
    storeId = store!.id;
    const [sku] = await db()
      .insert(s.skus)
      .values({
        orgId,
        code: `RT-${suffix.slice(-8)}`,
        names: { en: 'Rice' },
        unit: 'kg',
        step: '1',
      })
      .returning();
    skuId = sku!.id;
    const [user] = await db()
      .insert(s.users)
      .values({ displayName: 'Realtime staff', tgUserId: freshTgId() })
      .returning();
    noteUser(user!.id);
    const [member] = await db()
      .insert(s.members)
      .values({ orgId, userId: user!.id, status: 'active' })
      .returning();
    claimerMemberId = member!.id;
    claimerUserId = user!.id;
    await db()
      .insert(s.memberStoreAssignments)
      .values({ memberId: member!.id, storeId, assignedBy: user!.id });
    await db()
      .insert(s.memberRoleBindings)
      .values({ memberId: member!.id, roleId: roleId, scopeType: 'store', scopeId: storeId });
    const session = (await loadSession(app(), user!.id, orgId, member!.id)) as SessionContext;
    staff = callerFor(session);
    stopRelay = await relayDatabaseNotices(unprobed(app()).$client);
  });

  afterAll(async () => {
    await stopRelay?.();
  });

  const message = (lastSeq: number) => ({
    type: 'order.changed' as const,
    orgId,
    sessionId: orgId,
    lastSeq,
  });

  test('B9: nothing is sent until the transaction commits', async () => {
    const sink = listen(orgId);
    try {
      await withOrgContext(app(), orgId, async (tx) => {
        await tx.execute(sql`SELECT 1`);
        hub.publish(orgId, message(1));
        expect(sink.received).toEqual([]);
      });
      expect(sink.received).toEqual([message(1)]);
    } finally {
      sink.unsubscribe();
    }
  });

  test('B9: a rolled-back write is never announced', async () => {
    const sink = listen(orgId);
    try {
      await expect(
        withOrgContext(app(), orgId, async () => {
          hub.publish(orgId, message(2));
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(sink.received).toEqual([]);
    } finally {
      sink.unsubscribe();
    }
  });

  test('B9: a savepoint waits for the outer commit', async () => {
    const sink = listen(orgId);
    try {
      await withOrgContext(app(), orgId, async (tx) => {
        await withOrgContext(tx, orgId, async () => {
          hub.publish(orgId, message(3));
        });
        expect(sink.received).toEqual([]);
      });
      expect(sink.received).toEqual([message(3)]);
    } finally {
      sink.unsubscribe();
    }
  });

  test('B9: a client that refetches on the message reads the seq it announces', async () => {
    // What the client does on a message: read the order again, on
    // another connection. It must already see the announced seq.
    const reads: Array<Promise<number>> = [];
    const sink = listen(orgId, (m) => {
      if (m.type !== 'order.changed') return;
      reads.push(
        withSystemContext(db(), 'maintenance', async (tx) => {
          const [row] = await tx
            .select({ lastSeq: s.orderSessionsV.lastSeq })
            .from(s.orderSessionsV)
            .where(eq(s.orderSessionsV.id, m.sessionId as string));
          return Number(row?.lastSeq ?? -1);
        }),
      );
    });
    try {
      await staff.order.adjustItem({ storeId, skuId, qty: '1' });
      await staff.order.adjustItem({ storeId, skuId, qty: '2' });
      expect(reads.length).toBeGreaterThan(0);
      const announced = sink.received
        .filter((m) => m.type === 'order.changed')
        .map((m) => m.lastSeq);
      expect(await Promise.all(reads)).toEqual(announced as number[]);
    } finally {
      sink.unsubscribe();
    }
  });

  test('APR-12: a claim the worker releases reaches open pages, after commit', async () => {
    const sessionId = randomUUID();
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await db()
      .insert(s.orderSessionsV)
      .values({
        id: sessionId,
        orgId,
        storeId,
        orderDate: '2026-10-22',
        status: 'submitted',
        claimedByMemberId: claimerMemberId,
        claimedAt: ago(60),
        lastSeq: 4,
      });
    // ORD-07: the worker decides the release from the session's stream:
    // started, one line, submitted, and claimed an hour ago.
    const by = claimerMemberId;
    const stream: Array<[string, Record<string, unknown>]> = [
      ['DraftStarted', { orgId, storeId, initiatedByMemberId: by, orderDate: '2026-10-22' }],
      ['ItemAdjusted', { skuId, qty: '1', prevQty: '0', byMemberId: by, forMemberId: by }],
      ['Submitted', { itemCount: 1, byMemberId: by }],
      ['Claimed', { byMemberId: by }],
    ];
    await db()
      .insert(s.events)
      .values(
        stream.map(([type, payload], i) => ({
          id: randomUUID(),
          orgId,
          streamType: 'order',
          streamId: sessionId,
          seq: i + 1,
          type,
          payload,
          actorId: claimerUserId,
          occurredAt: ago(64 - i),
        })),
      );
    const reads: Array<Promise<unknown>> = [];
    const sink = listen(orgId, (m) => {
      if (m.sessionId !== sessionId) return;
      reads.push(
        withSystemContext(db(), 'maintenance', (tx) =>
          tx.query.orderSessionsV.findFirst({ where: (x, o) => o.eq(x.id, sessionId) }),
        ),
      );
    });
    try {
      // Rolled back: no message.
      await expect(
        withSystemContext(app(), 'worker', async (tx) => {
          expect(await releaseClaimIfExpired(tx, 'order', { id: sessionId, orgId }, 30)).toBe(true);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      const released = await withSystemContext(app(), 'worker', (tx) =>
        releaseClaimIfExpired(tx, 'order', { id: sessionId, orgId }, 30),
      );
      expect(released).toBe(true);
      await waitFor(() => sink.received.some((m) => m.sessionId === sessionId));
      await new Promise((r) => setTimeout(r, 200));
      expect(sink.received.filter((m) => m.sessionId === sessionId)).toEqual([
        { type: 'order.changed', orgId, sessionId, lastSeq: 5 },
      ]);
      const [row] = (await Promise.all(reads)) as Array<{
        claimedByMemberId: string | null;
        lastSeq: number;
      }>;
      expect(row?.claimedByMemberId).toBeNull();
      expect(Number(row?.lastSeq)).toBe(5);
    } finally {
      sink.unsubscribe();
    }
  });

  test('a worker-side notice from a rolled-back transaction is dropped', async () => {
    const sessionId = randomUUID();
    const sink = listen(orgId);
    try {
      await expect(
        withSystemContext(app(), 'worker', async (tx) => {
          await notifyRealtime(tx, { type: 'order.changed', orgId, sessionId, lastSeq: 9 });
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      await withSystemContext(app(), 'worker', (tx) =>
        notifyRealtime(tx, { type: 'order.changed', orgId, sessionId, lastSeq: 10 }),
      );
      await waitFor(() => sink.received.length > 0);
      await new Promise((r) => setTimeout(r, 200));
      expect(sink.received.map((m) => m.lastSeq)).toEqual([10]);
    } finally {
      sink.unsubscribe();
    }
  });
});
