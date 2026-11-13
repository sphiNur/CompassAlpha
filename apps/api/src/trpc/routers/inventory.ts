/**
 * Inventory router (M2.0a, 2026-05-08).
 *
 * Read + write surface for the inventory ledger. Procedures:
 *
 *   levels(storeId)         — current on-hand per SKU (SUM of deltas
 *                              from inventory.movements). Returns one
 *                              row per SKU with a non-zero on-hand
 *                              OR a recent movement (so stocked-out
 *                              items don't disappear from the UI).
 *
 *   stocktake(storeId, sku, target, note?)
 *                              — Operator counted the shelf and got
 *                              `target` units. We compute current
 *                              SUM, derive the delta, write a single
 *                              row with reason='stocktake'. Operators
 *                              can re-tally and post again; a retry of
 *                              the same post (same idempotency key)
 *                              replays instead (DX-INV-2).
 *
 *   stocktakeBatch(storeId, counts[], note?)
 *                              — D1 (2026-11-13): the count mode's one
 *                              save; each count applied as stocktake
 *                              applies one, all in one transaction.
 *
 *   recordWastage(storeId, sku, qty, note)
 *                              — Subtract `qty` from on-hand with a
 *                              mandatory note. Writes a negative-
 *                              delta row with reason='wastage'.
 *
 * Permissions:
 *   - levels:        any store member (read-only)
 *   - stocktake / wastage: members with `inventory.adjust` permission,
 *     scoped to the target store. New permission key added by this
 *     milestone — administrators get it automatically via the
 *     'admin' / 'super_admin' role bundles.
 *
 * Out of scope (will land in later M2.x steps):
 *   - Transfer-in / transfer-out between stores (needs paired rows).
 *   - Consumption from sales — needs Recipe/BOM (M2.0b → M2.0c).
 *   - Cost basis (FIFO / weighted-average). The ledger only tracks
 *     quantity; money stays in run_items / run_item_stores.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, type DB } from '@compass/db';
import {
  InventoryMovementsInputSchema,
  InventoryStoreInputSchema,
  StocktakeBatchInputSchema,
  StocktakeInputSchema,
  WastageInputSchema,
  milliQtyFixed,
  qtyMilli,
  qtyMilliOrZero,
} from '@compass/contracts';
import { authedProcedure, idempotentMutation, router } from '../trpc';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
} from '../../services/storeScope';
import { inUuids } from '../../services/sqlIn';

// 2026-10-21 CA-10/CA-57: `|| users.manage` fallback removed — it
// overrode store-level denies of inventory.adjust for managers and
// granted stocktake/wastage to any custom role holding users.manage.
// Migration 0048 backfills manager → inventory.adjust in older orgs.
function requireInventoryAdjust(perms: ReadonlySet<string>): void {
  if (!perms.has('inventory.adjust')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'inventory.errors.cannotAdjust',
    });
  }
}

/**
 * 2026-10-21 audit CA-54 (D-17): ledger writes must target an active
 * store of this org and a SKU of this org. The FKs alone accept another
 * org's SKU uuid and an archived/paused store. Error keys reuse the
 * settlement (store) and admin catalog (SKU) ones.
 */
async function assertWritableStoreAndSku(
  tx: DB,
  orgId: string,
  storeId: string,
  skuIds: readonly string[],
): Promise<void> {
  const store = await tx.query.stores.findFirst({
    where: (st, { eq: eq2, and: and2 }) => and2(eq2(st.id, storeId), eq2(st.orgId, orgId)),
    columns: { isActive: true, deletedAt: true },
  });
  if (!store || !store.isActive || store.deletedAt) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'auth.errors.storeArchived' });
  }
  // D1 (2026-11-13): every product of a count-mode save in one query.
  const found = await tx
    .select({ id: s.skus.id })
    .from(s.skus)
    .where(and(eq(s.skus.orgId, orgId), inArray(s.skus.id, [...skuIds])));
  if (found.length !== new Set(skuIds).size) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.skuNotFound' });
  }
}

/**
 * The checks every stock write makes, in the write's own transaction:
 * the actor is bound to the store, `inventory.adjust` holds there after
 * per-store overrides, and the store and products are writable.
 */
async function assertCanAdjustStore(
  tx: DB,
  session: { orgId: string; memberId: string; permissions: ReadonlySet<string> },
  storeId: string,
  skuIds: readonly string[],
): Promise<void> {
  // M3.7 (2026-05-15): store-scope assertion. The flat permission
  // check only says "this user can adjust inventory somewhere".
  // Without the assertion below, a manager-of-A with
  // `inventory.adjust` could call stocktake({storeId: <Store B>})
  // and post a delta to Store B's ledger. The effective-perm
  // override check below isn't enough — it composes the perm set
  // with per-store overrides but doesn't enforce store binding.
  // CONF-23: both checks run in the write's own transaction; they
  // used to take one each.
  await assertActorAssignedToStore(tx, session.memberId, storeId, session.permissions);
  // Per-store override check: an admin may have denied the actor
  // `inventory.adjust` specifically for this store.
  requireInventoryAdjust(
    await effectivePermissionsForStore(tx, session.memberId, storeId, session.permissions),
  );
  await assertWritableStoreAndSku(tx, session.orgId, storeId, skuIds);
}

/** What one product's count did; `inventory.stocktake` returns it as is. */
type StocktakeOutcome =
  | { skipped: true; currentOnHand: string }
  | { skipped: false; appliedDelta: string; newOnHand: string };

/**
 * Stocktake — set absolute on-hand for each product. Computes
 * (target - current) and writes one ledger row per product capturing the
 * delta, reason 'stocktake'. A product counted at exactly what the system
 * thought writes no row (keep the ledger lean). D1 (2026-11-13): shared
 * by the one-product stocktake and the count mode's batch, so a count
 * means the same either way (a later purge books back what it absorbed:
 * purgePlans' keepCountedStock looks for reason 'stocktake').
 */
async function applyStocktakes(
  tx: DB,
  orgId: string,
  storeId: string,
  memberId: string,
  counts: ReadonlyArray<{ skuId: string; target: string }>,
  note: string | undefined,
): Promise<Array<{ skuId: string } & StocktakeOutcome>> {
  // 2026-10-21 audit CA-54: serialize stocktakes per (store, sku) for the
  // rest of this tx. Without it two concurrent counts both read the same
  // SUM and both post a delta, double-applying it. D1: the locks of a
  // batch are taken in one order, so two batches cannot deadlock.
  const skuIds = counts.map((c) => c.skuId);
  for (const skuId of [...skuIds].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'inventory.stocktake:' + storeId + ':' + skuId}))`,
    );
  }
  // Current SUM(delta) of every counted product, one round-trip.
  const cur = OnHandBySkuRowsSchema.parse(
    await tx.execute(sql`
    SELECT sku_id::text AS sku_id, COALESCE(SUM(delta), 0)::text AS on_hand
    FROM inventory.movements
    WHERE org_id = ${orgId}
      AND store_id = ${storeId}
      AND sku_id IN ${inUuids(skuIds)}
    GROUP BY sku_id
  `),
  );
  const onHand = new Map(cur.map((r) => [r.sku_id, qtyMilliOrZero(r.on_hand)]));
  const occurredAt = new Date();
  const rows: Array<typeof s.inventoryMovements.$inferInsert> = [];
  const out: Array<{ skuId: string } & StocktakeOutcome> = [];
  for (const c of counts) {
    // The schema's stocktakeCountProblem already refused anything but a
    // non-negative decimal (CONF-23: a second check here was dead); it
    // read the text trimmed. Review QTY-03 (2026-11-11): in thousandths.
    const target = qtyMilli(c.target.trim());
    const current = onHand.get(c.skuId) ?? 0n;
    if (target === current) {
      // No-op stocktake; counted exactly what we thought.
      out.push({ skuId: c.skuId, skipped: true, currentOnHand: milliQtyFixed(current) });
      continue;
    }
    const delta = milliQtyFixed(target - current);
    rows.push({
      orgId,
      storeId,
      skuId: c.skuId,
      delta,
      reason: 'stocktake',
      note: note ?? null,
      sourceType: null,
      sourceId: null,
      actorMemberId: memberId,
      occurredAt,
    });
    out.push({
      skuId: c.skuId,
      skipped: false,
      appliedDelta: delta,
      newOnHand: milliQtyFixed(target),
    });
  }
  if (rows.length > 0) await tx.insert(s.inventoryMovements).values(rows);
  return out;
}

/** Rows of the raw queries below, checked instead of cast (review CONF-23). */
const LevelRowsSchema = z.array(
  z.object({
    sku_id: z.string(),
    on_hand: z.string(),
    // A raw `tx.execute` returns timestamptz as a string under postgres-js
    // (only Drizzle's typed selects map it to a Date), so calling
    // .toISOString() on it threw for every store with stock.
    last_movement_at: z.union([z.date(), z.string()]),
    movement_count: z.number(),
  }),
);
const OnHandBySkuRowsSchema = z.array(z.object({ sku_id: z.string(), on_hand: z.string() }));

export const inventoryRouter = router({
  /**
   * Returns the current on-hand for every SKU that's had at least one
   * movement on this store. SKUs with SUM=0 are still returned (the FE
   * needs to show "stocked out" rather than hide the row entirely);
   * SKUs that have never been touched on this store are omitted.
   */
  levels: authedProcedure.input(InventoryStoreInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      // M3.7 (2026-05-15): store-scope assertion. Pre-fix, this query
      // took input.storeId and returned on-hand for any guessed UUID
      // — a Store A cashier could read Store B's stock levels. Mirrors
      // the sales.list / sales.record gates from M3.1. Admins (with
      // `org.admin`) bypass via the helper.
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      );
      const orgId = ctx.session!.orgId;
      const rows = LevelRowsSchema.parse(
        await tx.execute(sql`
        SELECT
          m.sku_id::text   AS sku_id,
          SUM(m.delta)::text  AS on_hand,
          MAX(m.occurred_at)  AS last_movement_at,
          COUNT(*)::int       AS movement_count
        FROM inventory.movements m
        WHERE m.org_id = ${orgId}
          AND m.store_id = ${input.storeId}
        GROUP BY m.sku_id
        ORDER BY MAX(m.occurred_at) DESC
      `),
      );

      return rows.map((r) => ({
        skuId: r.sku_id,
        onHand: r.on_hand,
        lastMovementAt: new Date(r.last_movement_at).toISOString(),
        movementCount: r.movement_count,
      }));
    });
  }),

  /**
   * Recent movements for a (store, sku) — drill-down for "why is the
   * on-hand X?". Newest first, capped at 50 rows.
   */
  recentMovements: authedProcedure
    .input(InventoryMovementsInputSchema)
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        // M3.7: same gate as inventory.levels — without it, an actor
        // bound to Store A could read movement history for Store B
        // by passing its UUID.
        await assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        );
        const orgId = ctx.session!.orgId;
        const rows = await tx
          .select({
            id: s.inventoryMovements.id,
            delta: s.inventoryMovements.delta,
            reason: s.inventoryMovements.reason,
            note: s.inventoryMovements.note,
            sourceType: s.inventoryMovements.sourceType,
            sourceId: s.inventoryMovements.sourceId,
            occurredAt: s.inventoryMovements.occurredAt,
            // CLS-23 (2026-10-30): who wrote off / counted it.
            actorName: s.users.displayName,
          })
          .from(s.inventoryMovements)
          .leftJoin(s.members, eq(s.members.id, s.inventoryMovements.actorMemberId))
          .leftJoin(s.users, eq(s.users.id, s.members.userId))
          .where(
            and(
              eq(s.inventoryMovements.orgId, orgId),
              eq(s.inventoryMovements.storeId, input.storeId),
              eq(s.inventoryMovements.skuId, input.skuId),
            ),
          )
          .orderBy(desc(s.inventoryMovements.occurredAt))
          .limit(50);
        return rows;
      });
    }),

  /**
   * Stocktake of one product (applyStocktakes). Kept for a single
   * correction and for the Fine app; the count mode uses stocktakeBatch.
   */
  // DX-INV-2 (2026-11-01): idempotent. A lost-response retry with the
  // same X-Idempotency-Key replays the first answer; without it the retry
  // recomputed the delta against stock that sales had moved meanwhile and
  // posted a second correction.
  stocktake: idempotentMutation.input(StocktakeInputSchema).mutation(async ({ ctx, input }) => {
    requireInventoryAdjust(ctx.session!.permissions);
    return ctx.withOrg(async (tx): Promise<StocktakeOutcome> => {
      const session = ctx.session!;
      await assertCanAdjustStore(tx, session, input.storeId, [input.skuId]);
      const [res] = await applyStocktakes(
        tx,
        session.orgId,
        input.storeId,
        session.memberId,
        [{ skuId: input.skuId, target: input.target }],
        input.note,
      );
      const { skuId: _skuId, ...outcome } = res!;
      return outcome;
    });
  }),

  /**
   * D1 (2026-11-13): the count mode's save. Each count is applied exactly
   * as `stocktake` applies one, all in one transaction: either every
   * product typed is recorded, or none is. Idempotent like the others.
   */
  stocktakeBatch: idempotentMutation
    .input(StocktakeBatchInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireInventoryAdjust(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const session = ctx.session!;
        const skuIds = input.counts.map((c) => c.skuId);
        await assertCanAdjustStore(tx, session, input.storeId, skuIds);
        const results = await applyStocktakes(
          tx,
          session.orgId,
          input.storeId,
          session.memberId,
          input.counts,
          input.note,
        );
        return {
          applied: results.filter((r) => !r.skipped).length,
          results,
        };
      });
    }),

  /**
   * Wastage — log a quantity loss with mandatory note. Always writes
   * a row (no zero-delta short-circuit) since a wastage of zero is
   * meaningless.
   */
  // 2026-10-21 audit CA-54: idempotent — a lost-response retry with the
  // same X-Idempotency-Key replays instead of subtracting the qty twice.
  recordWastage: idempotentMutation.input(WastageInputSchema).mutation(async ({ ctx, input }) => {
    requireInventoryAdjust(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // M3.7: same gate as stocktake (above), in the same transaction.
      await assertCanAdjustStore(tx, ctx.session!, input.storeId, [input.skuId]);
      // QTY-03: exact; the schema allows 3 decimals at most.
      const negative = milliQtyFixed(-qtyMilli(input.qty));
      await tx.insert(s.inventoryMovements).values({
        orgId,
        storeId: input.storeId,
        skuId: input.skuId,
        delta: negative,
        reason: 'wastage',
        note: input.note,
        sourceType: 'manual',
        sourceId: null,
        actorMemberId: ctx.session!.memberId,
        occurredAt: new Date(),
      });
      return { ok: true as const };
    });
  }),
});
