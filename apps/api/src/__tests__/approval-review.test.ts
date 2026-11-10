/**
 * The approval card and claims (2026-10-31 decisions D12 / D13):
 *
 *   - U1: 通过 on the card keeps one tap, with an undo that is the normal
 *     unapprove sent with the lastSeq the approval returned — refused
 *     once anyone else has touched the order since.
 *   - U1: the card's amount only for approvers with prices.view.
 *   - U2: changing a quantity on an unclaimed order claims it in the same
 *     write, refused when the order changed after the version shown.
 *   - APR-13: the approver whose claim was taken over gets one in-app
 *     notification (no Telegram message), and RE-APR-2: cannot take it
 *     straight back.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/approval-review.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { claimTakenFrom, TAKEOVER_COOLDOWN_MS } from '../trpc/routers/order';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedMember, sessionOf } from './helpers/fixtures';
import { errorOf } from './helpers/errors';

type Caller = ReturnType<typeof appRouter.createCaller>;
interface Person {
  userId: string;
  memberId: string;
  caller: Caller;
}
interface Fixture {
  db: ReturnType<typeof getDb>;
  orgId: string;
  storeId: string;
  skuId: string;
  staff: Person;
  /** order.approve + claim + unapprove + prices.view */
  ann: Person;
  /** the same without prices.view */
  bob: Person;
}
let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `review-${suffix}`, name: 'Review', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Review store', code: `RV-${suffix.slice(-6)}` })
    .returning();
  const [sku] = await db
    .insert(s.skus)
    .values({
      orgId,
      code: `RV-${suffix.slice(-8)}`,
      names: { en: 'Onion' },
      unit: 'kg',
      step: '1',
    })
    .returning();
  await db.insert(s.priceHistory).values({ orgId, skuId: sku!.id, unitPrice: '5000', qty: '1' });

  const role = async (slug: string, rank: number, keys: string[]) => {
    const [r] = await db.insert(s.roles).values({ orgId, slug, name: slug, rank }).returning();
    for (const key of keys) {
      await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
      await db.insert(s.rolePermissions).values({ roleId: r!.id, permissionKey: key });
    }
    return r!.id;
  };
  const staffRole = await role('staff', 20, ['order.draft', 'order.submit']);
  const approverKeys = ['order.approve', 'order.claim', 'order.unapprove'];
  const pricedRole = await role('approver', 60, [...approverKeys, 'prices.view']);
  const plainRole = await role('approver-np', 50, approverKeys);

  const person = async (n: number, roleId: string): Promise<Person> => {
    const who = await seedMember(db, orgId, {
      name: `Reviewer ${n}`,
      stores: [store!.id],
      roles: [{ roleId, storeId: store!.id }],
    });
    const caller = callerFor(await sessionOf(orgId, who));
    return { userId: who.userId, memberId: who.memberId, caller };
  };
  fix = {
    db,
    orgId,
    storeId: store!.id,
    skuId: sku!.id,
    staff: await person(1, staffRole),
    ann: await person(2, pricedRole),
    bob: await person(3, plainRole),
  };
});

/** A fresh order from the staff member, submitted. */
async function submittedOrder(qty = '3'): Promise<{ sessionId: string; lastSeq: number }> {
  const { staff, storeId, skuId } = fix!;
  const { sessionId } = await staff.caller.order.adjustItem({ storeId, skuId, qty });
  const { lastSeq } = await staff.caller.order.submit({ sessionId });
  return { sessionId, lastSeq };
}

async function row(sessionId: string) {
  return fix!.db.query.orderSessionsV.findFirst({ where: (x, o) => o.eq(x.id, sessionId) });
}

describe.skipIf(!SHOULD_RUN)('approval review (PG-gated)', () => {
  test('U1: the undo of an approval works until someone else acts on the order', async () => {
    const { ann, bob } = fix!;
    const a = await submittedOrder();
    const approved = await ann.caller.order.approve({
      sessionId: a.sessionId,
      expectedSeq: a.lastSeq,
    });
    await ann.caller.order.unapprove({ sessionId: a.sessionId, expectedSeq: approved.lastSeq });
    expect((await row(a.sessionId))!.status).toBe('submitted');

    const b = await submittedOrder();
    const first = await ann.caller.order.approve({
      sessionId: b.sessionId,
      expectedSeq: b.lastSeq,
    });
    // Someone else reopens and approves it again in the meantime.
    await bob.caller.order.unapprove({ sessionId: b.sessionId });
    await bob.caller.order.approve({ sessionId: b.sessionId });
    expect(
      await errorOf(() =>
        ann.caller.order.unapprove({ sessionId: b.sessionId, expectedSeq: first.lastSeq }),
      ),
    ).toMatchObject({ message: 'order.errors.staleSeq' });
    expect((await row(b.sessionId))!.status).toBe('approved');
  });

  test('U1: the card shows the amount only with prices.view', async () => {
    const { ann, bob, storeId } = fix!;
    const { sessionId } = await submittedOrder('2');
    const withPrices = (await ann.caller.order.pendingList({ storeId, status: 'submitted' })).find(
      (r) => r.id === sessionId,
    );
    expect(withPrices?.itemCount).toBe(1);
    expect(Number(withPrices?.estimatedTotal)).toBe(10000);
    const without = (await bob.caller.order.pendingList({ storeId, status: 'submitted' })).find(
      (r) => r.id === sessionId,
    );
    expect(without?.itemCount).toBe(1);
    expect(without?.estimatedTotal).toBeNull();
  });

  test('U2: changing a quantity on an unclaimed order claims it in the same write', async () => {
    const { ann, bob, staff, storeId, skuId } = fix!;
    const { sessionId, lastSeq } = await submittedOrder('3');
    const edit = (who: Person, qty: string, expectedSeq?: number) =>
      who.caller.order.adjustItem({
        storeId,
        skuId,
        qty,

        targetMemberId: staff.memberId,
        sessionId,
        expectedSeq,
      });
    await edit(ann, '5', lastSeq);
    const after = await row(sessionId);
    expect(after!.claimedByMemberId).toBe(ann.memberId);
    const items = await fix!.db.query.orderItemsV.findMany({
      where: (x, o) => o.eq(x.sessionId, sessionId),
    });
    expect(items.map((i) => Number(i.qty))).toEqual([5]);
    // The claim is real: the next approver is told someone is reviewing.
    expect(await errorOf(() => edit(bob, '6', after!.lastSeq))).toMatchObject({
      message: 'order.errors.notEditor',
    });
  });

  test('U2: the edit is refused when the order changed after the version shown', async () => {
    const { ann, staff, storeId, skuId } = fix!;
    const { sessionId, lastSeq } = await submittedOrder('3');
    // The submitter takes it back, changes it and sends it again.
    await staff.caller.order.withdraw({ sessionId });
    await staff.caller.order.adjustItem({ storeId, skuId, qty: '4' });
    await staff.caller.order.submit({ sessionId });
    expect(
      await errorOf(() =>
        ann.caller.order.adjustItem({
          storeId,
          skuId,
          qty: '9',

          targetMemberId: staff.memberId,
          sessionId,
          expectedSeq: lastSeq,
        }),
      ),
    ).toMatchObject({ message: 'order.errors.staleSeq' });
    expect((await row(sessionId))!.claimedByMemberId).toBeNull();
  });

  test('APR-13 / RE-APR-2: a take-over notifies the one who lost the claim, who cannot snatch it back', async () => {
    const { ann, bob, db } = fix!;
    const { sessionId } = await submittedOrder();
    await ann.caller.order.claim({ sessionId });
    await bob.caller.order.takeOverClaim({ sessionId, fromMemberId: ann.memberId });
    expect((await row(sessionId))!.claimedByMemberId).toBe(bob.memberId);

    const notes = await db
      .select()
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.recipientUserId, ann.userId),
          eq(s.notifications.template, 'order.claimTakenOver'),
        ),
      );
    expect(notes.map((n) => n.channel)).toEqual(['inapp']);
    expect((notes[0]!.payload as { sessionId?: string }).sessionId).toBe(sessionId);
    const queued = (await db.execute(
      sql`SELECT count(*)::int AS n FROM sync.outbox WHERE payload->>'recipientUserId' = ${ann.userId}
            AND payload->>'template' = 'order.claimTakenOver'`,
    )) as unknown as Array<{ n: number }>;
    expect(queued[0]!.n).toBe(0);

    expect(
      await errorOf(() =>
        ann.caller.order.takeOverClaim({ sessionId, fromMemberId: bob.memberId }),
      ),
    ).toMatchObject({ message: 'order.errors.takeOverCooldown' });
    expect((await row(sessionId))!.claimedByMemberId).toBe(bob.memberId);
  });

  test('RE-APR-2: the cooldown ends, and only binds the one the claim was taken from', () => {
    const released = {
      type: 'ClaimReleased',
      payload: { reason: 'override', fromMemberId: 'ann', byMemberId: 'bob' },
    };
    const events = [released] as unknown as Parameters<typeof claimTakenFrom>[0];
    const claimedAt = new Date('2026-10-31T10:00:00Z');
    const t0 = claimedAt.getTime();
    expect(claimTakenFrom(events, 'ann', claimedAt, t0 + 1000)).toBe(true);
    expect(claimTakenFrom(events, 'carl', claimedAt, t0 + 1000)).toBe(false);
    expect(claimTakenFrom(events, 'ann', claimedAt, t0 + TAKEOVER_COOLDOWN_MS)).toBe(false);
  });
});
