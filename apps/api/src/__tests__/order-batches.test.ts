/**
 * ORD-4 (2026-10-30): a staff member can open any of their batches of the
 * day, and a rejected batch carries its reason in the day's list.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/order-batches.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: { storeId: string; skuId: string; staff: Caller; other: Caller; manager: Caller; manager2: Caller } | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `batches-${suffix}`, name: 'Batches', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleIds = await seedRoles(db, orgId, ['manager', 'staff']);
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `B-${suffix.slice(-6)}` }).returning();
  const [sku] = await db.insert(s.skus).values({ orgId, code: `BT-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' }).returning();
  let n = 0;
  const member = async (slug: string) => {
    n += 1;
    const who = await seedMember(db, orgId, {
      name: `Batches ${n}`,
      stores: [store!.id],
      roles: [{ roleId: roleIds[slug]!, storeId: store!.id }],
    });
    return callerFor(await sessionOf(orgId, who));
  };
  fix = { storeId: store!.id, skuId: sku!.id, staff: await member('staff'), other: await member('staff'), manager: await member('manager'), manager2: await member('manager') };
});

describe.skipIf(!SHOULD_RUN)('order batches (PG-gated)', () => {
  test('a batch can be opened by id; a rejected one says why; another member gets nothing', async () => {
    const { staff, other, manager, storeId, skuId } = fix!;
    const first = await staff.order.adjustItem({ storeId, skuId, qty: '2' });
    await staff.order.submit({ sessionId: first.sessionId });
    const second = await staff.order.adjustItem({ storeId, skuId, qty: '1' });
    await manager.order.claim({ sessionId: first.sessionId });
    await manager.order.reject({ sessionId: first.sessionId, reason: 'too much' });

    // Default pick is the open draft; the rejected batch is reachable by id.
    expect((await staff.order.todaySession({ storeId }))?.id).toBe(second.sessionId);
    const picked = await staff.order.todaySession({ storeId, sessionId: first.sessionId });
    expect(picked?.status).toBe('rejected');
    const batches = await staff.order.todayBatches({ storeId });
    expect(batches.find((b) => b.id === first.sessionId)?.rejectReason).toBe('too much');
    expect(await other.order.todaySession({ storeId, sessionId: first.sessionId })).toBeNull();
  });

  test('ORD-04: an idempotency key that is not a uuid is kept, not a 500', async () => {
    const { other, storeId, skuId } = fix!;
    // The contract allows 8-128 of [A-Za-z0-9_-:.]; correlation_id is a uuid
    // column, and this key used to fail the insert.
    const key = 'fine-app:retry.0001';
    const draft = await other.order.adjustItem({ storeId, skuId, qty: '3', idempotencyKey: key });
    const db = getDb(undefined, { system: 'maintenance' });
    const events = await db.query.events.findMany({
      where: (e, { eq }) => eq(e.streamId, draft.sessionId),
    });
    const adjusted = events.find((e) => e.type === 'ItemAdjusted');
    expect(adjusted?.idempotencyKey).toBe(key);
    expect(adjusted?.correlationId).toBeNull();
  });

  test('ORD-05: an order as submitted is for its author and the store\'s approvers', async () => {
    const { staff, other, manager, storeId, skuId } = fix!;
    const draft = await staff.order.adjustItem({ storeId, skuId, qty: '5' });
    await staff.order.submit({ sessionId: draft.sessionId });
    expect((await staff.order.submittedVersion({ sessionId: draft.sessionId }))?.totals).toEqual([
      { skuId, qty: '5' },
    ]);
    expect(await manager.order.submittedVersion({ sessionId: draft.sessionId })).not.toBeNull();
    // Another member of the same store: refused, as by sessionDetail.
    await expect(other.order.submittedVersion({ sessionId: draft.sessionId })).rejects.toThrow(
      'order.errors.cannotApprove',
    );
    await expect(other.order.sessionDetail({ sessionId: draft.sessionId })).rejects.toThrow(
      'order.errors.cannotApprove',
    );
  });

  test('APR-13: taking over a claim leaves it claimed by the one who took it', async () => {
    const { staff, manager, manager2, storeId, skuId } = fix!;
    const draft = await staff.order.adjustItem({ storeId, skuId, qty: '4' });
    await staff.order.submit({ sessionId: draft.sessionId });
    await manager.order.claim({ sessionId: draft.sessionId });
    await manager2.order.takeOverClaim({ sessionId: draft.sessionId });
    const detail = await manager2.order.sessionDetail({ sessionId: draft.sessionId });
    expect((detail as { claimedByMemberId?: string | null }).claimedByMemberId).toBeTruthy();
    // The first claimer can no longer approve; the one who took over can.
    await expect(manager.order.approve({ sessionId: draft.sessionId })).rejects.toThrow(
      'order.errors.claimedByOther',
    );
    await manager2.order.approve({ sessionId: draft.sessionId });
  });

  test('APR-19: two approvers claiming at once — the loser is told it is already claimed', async () => {
    const { staff, manager, manager2, storeId, skuId } = fix!;
    const draft = await staff.order.adjustItem({ storeId, skuId, qty: '6' });
    await staff.order.submit({ sessionId: draft.sessionId });
    const results = await Promise.allSettled([
      manager.order.claim({ sessionId: draft.sessionId }),
      manager2.order.claim({ sessionId: draft.sessionId }),
    ]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const f of failed) expect((f.reason as Error).message).toBe('order.errors.alreadyClaimed');
  });

  test('ORD-17: extras suggestions keep how names were written and skip drafts', async () => {
    const { other, storeId } = fix!;
    const sent = await other.order.setSessionExtras({
      storeId,
      extras: [{ name: 'Laundry Detergent', qty: '2', unit: 'pack' }],
    });
    await other.order.submit({ sessionId: sent.sessionId! });
    // A half-typed name still sitting in a draft is not a suggestion.
    await other.order.setSessionExtras({ storeId, extras: [{ name: 'laun', qty: '1', unit: 'pack' }] });
    const names = (await other.order.extrasSuggestions({ storeId })).map((s) => s.name);
    expect(names).toContain('Laundry Detergent');
    expect(names).not.toContain('laun');
  });
});

