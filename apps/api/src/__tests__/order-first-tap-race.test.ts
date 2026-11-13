/**
 * ORD-6 / ORD-7 (2026-10-30 operation atlas): two devices of one person
 * making the day's first change at once used to answer one of them with
 * a 500 and lose that tap; ordering in a store without order.draft
 * answered 500 instead of 403. Review ORD-06 (2026-11-11): the extras
 * list still answered 500 when it lost that race; it is decided again
 * now, as adjustItem is.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/order-first-tap-race.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s, type DB } from '@compass/db';
import { todayInTz } from '@compass/domain';
import { decide, emptyState } from '@compass/domain/order';
import { appRouter } from '../trpc/router';
import { writeOrderEvents } from '../services/streamWrite';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { codeOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';
import { middayZone } from './helpers/zone';

cleanUpAfterAll();

/** The calls send no date, so the server takes the org's today; where it is
 *  midday that does not change while the file runs (review TEST1-09). */
const TZ = middayZone(new Date());

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: {
  orgId: string;
  storeId: string;
  skuIds: string[];
  staff: Array<{ memberId: string; devices: () => Promise<[Caller, Caller]> }>;
  /** Someone with no order yet, for the extras race. */
  racer: { userId: string; memberId: string; devices: () => Promise<[Caller, Caller]> };
  noDraft: Caller;
} | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `race-${suffix}`, name: 'First tap race', localeDefault: 'en', timezone: TZ })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleIds = await seedRoles(db, orgId, ['staff', 'purchaser']);
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `R-${suffix.slice(-6)}` }).returning();
  const skuIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const [sku] = await db
      .insert(s.skus)
      .values({ orgId, code: `RC-${suffix.slice(-6)}-${i}`, names: { en: `Item ${i}` }, unit: 'kg', step: '1' })
      .returning();
    skuIds.push(sku!.id);
  }
  let n = 0;
  const person = async (slug: string) => {
    n += 1;
    const who = await seedMember(db, orgId, {
      name: `P${n}`,
      stores: [store!.id],
      roles: [{ roleId: roleIds[slug]!, storeId: store!.id }],
    });
    const caller = async () => callerFor(await sessionOf(orgId, who));
    return {
      userId: who.userId,
      memberId: who.memberId,
      devices: async () => [await caller(), await caller()] as [Caller, Caller],
    };
  };
  const staff = [await person('staff'), await person('staff'), await person('staff')];
  const racer = await person('staff');
  const buyer = await person('purchaser');
  fix = {
    orgId,
    storeId: store!.id,
    skuIds,
    staff,
    racer,
    noDraft: (await buyer.devices())[0],
  };
});

describe.skipIf(!SHOULD_RUN)('the day\'s first change from two devices (PG-gated)', () => {
  test('ORD-6: both taps land, on one draft', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    for (const [i, p] of fix!.staff.entries()) {
      const [a, b] = await p.devices();
      const results = await Promise.allSettled([
        a.order.adjustItem({ storeId: fix!.storeId, skuId: fix!.skuIds[i * 2]!, qty: '2' }),
        b.order.adjustItem({ storeId: fix!.storeId, skuId: fix!.skuIds[i * 2 + 1]!, qty: '3' }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const drafts = await db
        .select({ id: s.orderSessionsV.id })
        .from(s.orderSessionsV)
        .where(and(eq(s.orderSessionsV.initiatedByMemberId, p.memberId), eq(s.orderSessionsV.status, 'draft')));
      expect(drafts).toHaveLength(1);
      const items = await db.select().from(s.orderItemsV).where(eq(s.orderItemsV.sessionId, drafts[0]!.id));
      expect(items).toHaveLength(2);
    }
  });

  test('ORD-06: an extras list that loses the race for the draft joins the one that won', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const { orgId, storeId, racer } = fix!;
    const [device] = await racer.devices();
    // The other device's first change, not committed yet: its draft holds
    // the one-draft-a-day index, for the day the server takes as today.
    const wonId = randomUUID();
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let written!: () => void;
    const held = new Promise<void>((r) => {
      written = r;
    });
    const holder = db.transaction(async (tx) => {
      const started = decide(emptyState(wonId), {
        type: 'StartDraft',
        orgId,
        storeId,
        orderDate: todayInTz(TZ),
        actor: {
          userId: racer.userId,
          memberId: racer.memberId,
          permissions: new Set(['order.draft']),
          isClaimer: false,
        },
      });
      // Drizzle's transaction has the handle's query API (as withOrgContext).
      await writeOrderEvents(tx as unknown as DB, orgId, wonId, started);
      written();
      await released;
    });
    await held;

    const saving = device.order.setSessionExtras({
      storeId,
      extras: [{ name: 'Napkins', qty: '1', unit: 'pack' }],
    });
    // Wait until it is blocked on the winner's draft.
    for (let i = 0; i < 100; i += 1) {
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `)) as unknown as Array<{ n: number }>;
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await holder;

    expect(await saving).toMatchObject({ sessionId: wonId });
    const drafts = await db
      .select({ id: s.orderSessionsV.id, extras: s.orderSessionsV.extrasJson })
      .from(s.orderSessionsV)
      .where(
        and(
          eq(s.orderSessionsV.initiatedByMemberId, racer.memberId),
          eq(s.orderSessionsV.status, 'draft'),
        ),
      );
    expect(drafts).toEqual([{ id: wonId, extras: [{ name: 'Napkins', qty: '1', unit: 'pack' }] }]);
  });

  test('ORD-7: ordering where one has no order.draft is FORBIDDEN, not a server error', async () => {
    const order = () =>
      fix!.noDraft.order.adjustItem({ storeId: fix!.storeId, skuId: fix!.skuIds[0]!, qty: '1' });
    expect(await codeOf(order)).toBe('FORBIDDEN');
  });
});
