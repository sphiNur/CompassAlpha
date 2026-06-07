/**
 * Inventory router (M2.0a, 2026-05-08).
 *
 * Read + write surface for the inventory ledger. Three procedures:
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
 *                              row with reason='stocktake'. Idempotent
 *                              by (sourceType=null) — operators can
 *                              re-tally and post again.
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
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import {
  DecimalStringSchema,
  PositiveDecimalStringSchema,
  UuidSchema,
} from '@compass/contracts';
import { authedProcedure, router } from '../trpc';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
} from '../../services/storeScope';

function requireInventoryAdjust(perms: ReadonlySet<string>): void {
  if (!perms.has('inventory.adjust') && !perms.has('users.manage')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'inventory.errors.cannotAdjust',
    });
  }
}

const ListInputSchema = z.object({
  storeId: UuidSchema,
});

const StocktakeInputSchema = z.object({
  storeId: UuidSchema,
  skuId: UuidSchema,
  /** Target on-hand qty after the stocktake. Must be ≥ 0. */
  target: z
    .string()
    .regex(/^\d+(\.\d{1,3})?$/, 'qty must be ≥ 0 with at most 3 decimals'),
  note: z.string().max(500).optional(),
});

const WastageInputSchema = z.object({
  storeId: UuidSchema,
  skuId: UuidSchema,
  qty: PositiveDecimalStringSchema,
  /** Mandatory reason — wastage rows without context are useless. */
  note: z.string().min(1).max(500),
});

export const inventoryRouter = router({
  /**
   * Returns the current on-hand for every SKU that's had at least one
   * movement on this store. SKUs with SUM=0 are still returned (the FE
   * needs to show "stocked out" rather than hide the row entirely);
   * SKUs that have never been touched on this store are omitted.
   */
  levels: authedProcedure.input(ListInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      // M3.7 (2026-05-15): store-scope assertion. Pre-fix, this query
      // took input.storeId and returned on-hand for any guessed UUID
      // — a Store A cashier could read Store B's stock levels. Mirrors
      // the sales.list / sales.record gates from M3.1. Admins (with
      // `users.manage`) bypass via the helper.
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
        { bypassUsersManage: ctx.session!.permissions.has('org.admin') },
      );
      const orgId = ctx.session!.orgId;
      const rows = (await tx.execute(sql`
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
      `)) as unknown as Array<{
        sku_id: string;
        on_hand: string;
        last_movement_at: Date;
        movement_count: number;
      }>;

      return rows.map((r) => ({
        skuId: r.sku_id,
        onHand: r.on_hand,
        lastMovementAt: r.last_movement_at.toISOString(),
        movementCount: r.movement_count,
      }));
    });
  }),

  /**
   * Recent movements for a (store, sku) — drill-down for "why is the
   * on-hand X?". Newest first, capped at 50 rows.
   */
  recentMovements: authedProcedure
    .input(z.object({ storeId: UuidSchema, skuId: UuidSchema }))
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
          { bypassUsersManage: ctx.session!.permissions.has('org.admin') },
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
          })
          .from(s.inventoryMovements)
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
   * Stocktake — set absolute on-hand. Computes (target - current) and
   * writes a single ledger row capturing the delta. If the operator
   * counted exactly what the system thought, delta = 0 and no row is
   * written (keep the ledger lean).
   */
  stocktake: authedProcedure
    .input(StocktakeInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireInventoryAdjust(ctx.session!.permissions);
      // M3.7 (2026-05-15): store-scope assertion. The flat permission
      // check only says "this user can adjust inventory somewhere".
      // Without the assertion below, a manager-of-A with
      // `inventory.adjust` could call stocktake({storeId: <Store B>})
      // and post a delta to Store B's ledger. The effective-perm
      // override check below isn't enough — it composes the perm set
      // with per-store overrides but doesn't enforce store binding.
      await ctx.withOrg((tx) =>
        assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
          { bypassUsersManage: ctx.session!.permissions.has('org.admin') },
        ),
      );
      // Per-store override check: an admin may have denied the actor
      // `inventory.adjust` specifically for this store.
      const effective = await ctx.withOrg((tx) =>
        effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        ),
      );
      requireInventoryAdjust(effective);

      const targetNum = Number(input.target);
      if (!Number.isFinite(targetNum) || targetNum < 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'inventory.errors.invalidQty',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        // Compute current SUM(delta) so we can write the right delta
        // to make SUM = target. Single round-trip.
        const cur = (await tx.execute(sql`
          SELECT COALESCE(SUM(delta), 0)::text AS on_hand
          FROM inventory.movements
          WHERE org_id = ${orgId}
            AND store_id = ${input.storeId}
            AND sku_id = ${input.skuId}
        `)) as unknown as Array<{ on_hand: string }>;
        const current = Number(cur[0]?.on_hand ?? '0');
        const delta = (targetNum - current).toFixed(3);
        if (Math.abs(Number(delta)) < 0.0005) {
          // No-op stocktake; counted exactly what we thought. Don't
          // bloat the ledger with empty rows.
          return { skipped: true as const, currentOnHand: current.toFixed(3) };
        }
        await tx.insert(s.inventoryMovements).values({
          orgId,
          storeId: input.storeId,
          skuId: input.skuId,
          delta,
          reason: 'stocktake',
          note: input.note ?? null,
          sourceType: null,
          sourceId: null,
          actorMemberId: ctx.session!.memberId,
          occurredAt: new Date(),
        });
        return {
          skipped: false as const,
          appliedDelta: delta,
          newOnHand: targetNum.toFixed(3),
        };
      });
    }),

  /**
   * Wastage — log a quantity loss with mandatory note. Always writes
   * a row (no zero-delta short-circuit) since a wastage of zero is
   * meaningless.
   */
  recordWastage: authedProcedure
    .input(WastageInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireInventoryAdjust(ctx.session!.permissions);
      // M3.7: same gate as stocktake (above).
      await ctx.withOrg((tx) =>
        assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
          { bypassUsersManage: ctx.session!.permissions.has('org.admin') },
        ),
      );
      const effective = await ctx.withOrg((tx) =>
        effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        ),
      );
      requireInventoryAdjust(effective);

      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const negative = '-' + Number(input.qty).toFixed(3);
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

void DecimalStringSchema;
