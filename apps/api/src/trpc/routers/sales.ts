/**
 * Sales router (M2.0c, 2026-05-08).
 *
 * Closes the ERP loop: purchase → receive (M2.0a) → menu + BOM
 * (M2.0b) → consume (M2.0c).
 *
 * Two procedures:
 *
 *   record(storeId, dishId, qty, occurredAt?)
 *     Logs one sale event AND writes the corresponding ingredient
 *     deductions in a single DB transaction. If the dish has no
 *     recipe, the sale is rejected — recording consumption with no
 *     deduction would leave inventory wrong. Per-store gated
 *     (`sales.record`, with per-store effective-perm override).
 *
 *   list(storeId, fromDate, toDate)
 *     Lists recorded sales in the range. Newest first. Cap 200 rows
 *     per call (covers a busy week per store).
 *
 * What happens on `record`:
 *
 *   1. Validate qty > 0 and dish belongs to org.
 *   2. Read the dish's `dish_ingredients` rows. Reject if empty
 *      (operator should set a recipe first).
 *   3. Insert `inventory.sales` row.
 *   4. Bulk-insert `inventory.movements` rows — one per ingredient
 *      with delta = -(qty × qtyPerServing), sourceType='sale',
 *      sourceId=<sale.id>, reason='consumption'.
 *   5. Return { saleId, deducted: [{skuId, qty}] }.
 *
 * Idempotency: `record` is an `idempotentMutation` — a retry that
 * carries the SAME X-Idempotency-Key replays the cached response
 * instead of running again. That header is the ONLY replay guard.
 * 2026-10-21 audit CA-21: the partial UNIQUE index on
 * `inventory.movements (source_type, source_id, store_id, sku_id)` does
 * NOT dedupe retries — every call mints a fresh sale id as source_id —
 * it only stops one sale from writing two rows for the same SKU.
 * Clients must therefore send a stable key per logical sale.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import {
  DateStringSchema,
  PositiveDecimalStringSchema,
  UuidSchema,
} from '@compass/contracts';
import { todayInTz } from '@compass/domain';
import { authedProcedure, idempotentMutation, router } from '../trpc';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
} from '../../services/storeScope';

// 2026-10-21 CA-10/CA-57: no `|| users.manage` fallback any more. It
// made a store-level deny of sales.record a no-op for managers (who
// hold users.manage) and let any custom role with users.manage record
// sales. Migration 0048 backfills the built-in role grants (manager,
// staff, cashier → sales.record) so older orgs don't lose access.
function requireSalesRecord(perms: ReadonlySet<string>): void {
  if (!perms.has('sales.record')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'sales.errors.cannotRecord',
    });
  }
}

const RecordInputSchema = z.object({
  storeId: UuidSchema,
  dishId: UuidSchema,
  qty: PositiveDecimalStringSchema,
  /** Optional ISO timestamp; defaults to NOW(). Lets shift leads
   *  back-fill the day's sales at close-out. */
  occurredAt: z.string().datetime().optional(),
});

const ListInputSchema = z.object({
  storeId: UuidSchema,
  /** Inclusive start, a business date in the store's timezone (falling
   *  back to the org timezone). Defaults to that timezone's today. */
  fromDate: DateStringSchema.optional(),
  /** Inclusive end business date, same timezone. Defaults to today. */
  toDate: DateStringSchema.optional(),
});

/** UTC offset (ms) of `tz` at instant `at`: local wall clock − UTC. */
function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of local 00:00 on `date` (YYYY-MM-DD) in `tz`. */
function startOfDayInTz(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wallMidnight = Date.UTC(y, m - 1, d);
  // Two passes so a DST transition between the guess and the answer
  // still lands on the correct offset.
  const first = wallMidnight - tzOffsetMs(tz, new Date(wallMidnight));
  return new Date(wallMidnight - tzOffsetMs(tz, new Date(first)));
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * 2026-10-21 audit CA-23 (D-03): sales.list day boundaries in the
 * store's business timezone (store.timezone || org timezone — the same
 * resolution settlement.ts uses), not UTC. Returns a half-open
 * [from, toExclusive) instant range. Exported for unit tests.
 */
export function salesListRange(
  tz: string,
  fromDate: string | undefined,
  toDate: string | undefined,
  now: Date = new Date(),
): { from: Date; toExclusive: Date } {
  const today = todayInTz(tz, now);
  return {
    from: startOfDayInTz(fromDate ?? today, tz),
    toExclusive: startOfDayInTz(nextDate(toDate ?? today), tz),
  };
}

export const salesRouter = router({
  // M1.20: idempotent — sales.record writes a sale row AND the
  // ingredient-deduction movements in one tx. Network retry without
  // a STABLE key = double inventory deduction (nothing else dedupes;
  // see the header note, audit CA-21).
  record: idempotentMutation
    .input(RecordInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireSalesRecord(ctx.session!.permissions);
      // M3.1 (2026-05-15): store-scope assertion BEFORE per-store
      // override evaluation. The flat permission set says "this user
      // can record sales somewhere"; we must confirm the somewhere
      // includes input.storeId. Without this a staff at Store A could
      // post a sale with storeId=<Store B> and the only gate would be
      // perm presence (Store A staff has sales.record from their role
      // globally) — Store B's inventory would silently get deducted.
      await ctx.withOrg((tx) =>
        assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        ),
      );
      // Per-store override: an admin may have explicitly denied this
      // actor sales.record on this specific store.
      const effective = await ctx.withOrg((tx) =>
        effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        ),
      );
      requireSalesRecord(effective);

      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;

        // 1. Verify the dish exists in this org.
        const dish = await tx.query.dishes.findFirst({
          where: (d, { eq: eq2, and: and2 }) =>
            and2(eq2(d.id, input.dishId), eq2(d.orgId, orgId)),
        });
        if (!dish) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'sales.errors.dishNotFound' });
        }
        if (dish.isArchived) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'sales.errors.dishArchived',
          });
        }

        // 2. Verify the store exists in this org.
        const store = await tx.query.stores.findFirst({
          where: (st, { eq: eq2, and: and2 }) =>
            and2(eq2(st.id, input.storeId), eq2(st.orgId, orgId)),
        });
        if (!store) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'sales.errors.storeNotFound' });
        }
        // 2026-10-21 CA-10 (D-track follow-up): an archived/paused store
        // must not take new sales — each one deducts that store's
        // inventory. Same key as the inventory ledger guard (CA-54).
        if (!store.isActive || store.deletedAt) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'auth.errors.storeArchived',
          });
        }

        // 3. Read the dish's recipe.
        const recipe = await tx
          .select({
            skuId: s.dishIngredients.skuId,
            qtyPerServing: s.dishIngredients.qtyPerServing,
          })
          .from(s.dishIngredients)
          .where(eq(s.dishIngredients.dishId, input.dishId));
        if (recipe.length === 0) {
          // Recording consumption with no deduction would leave
          // inventory inaccurate. Fail loudly so the operator goes
          // back and writes a recipe.
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'sales.errors.dishHasNoRecipe',
          });
        }

        // 4. Insert the sale row.
        const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
        const [inserted] = await tx
          .insert(s.sales)
          .values({
            orgId,
            storeId: input.storeId,
            dishId: input.dishId,
            qty: input.qty,
            // Snapshot the dish's selling price at sale time. If the
            // dish has no price set we record NULL (still a valid
            // consumption event; revenue rolls up to "—" later).
            unitPrice: dish.unitPrice,
            recordedByMemberId: ctx.session!.memberId,
            occurredAt,
          })
          .returning({ id: s.sales.id });

        const saleId = inserted!.id;

        // 5. Auto-deduct ingredient inventory.
        const saleQty = Number(input.qty);
        const deductions = recipe.map((r) => {
          const lineQty = Number(r.qtyPerServing) * saleQty;
          // Negative delta — that's a consumption.
          const delta = (-lineQty).toFixed(3);
          return { skuId: r.skuId, qty: lineQty.toFixed(3), delta };
        });

        await tx
          .insert(s.inventoryMovements)
          .values(
            deductions.map((d) => ({
              orgId,
              storeId: input.storeId,
              skuId: d.skuId,
              delta: d.delta,
              reason: 'consumption' as const,
              sourceType: 'sale' as const,
              sourceId: saleId,
              actorMemberId: ctx.session!.memberId,
              occurredAt,
            })),
          )
          .onConflictDoNothing();

        return {
          saleId,
          deducted: deductions.map(({ skuId, qty }) => ({ skuId, qty })),
        };
      });
    }),

  list: authedProcedure.input(ListInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // M3.1 (2026-05-15): store-scope assertion. Without this a staff
      // member assigned only to Store A could pass storeId=<Store B uuid>
      // and read Store B's entire sales history (RLS only filters by
      // org, not by store, so the leak isn't caught at the DB layer
      // either — see migration 0014).
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      );
      // 2026-10-21 audit CA-23: business-day boundaries in the store's
      // timezone (falling back to the org's), matching settlement. Was
      // UTC, which put 00:00–05:00 Tashkent sales on "yesterday".
      const store = await tx.query.stores.findFirst({
        where: (st, { eq: eq2, and: and2 }) =>
          and2(eq2(st.id, input.storeId), eq2(st.orgId, orgId)),
        columns: { timezone: true },
      });
      const { from, toExclusive } = salesListRange(
        store?.timezone || ctx.session!.orgTimezone,
        input.fromDate,
        input.toDate,
      );

      const rows = await tx
        .select({
          id: s.sales.id,
          dishId: s.sales.dishId,
          qty: s.sales.qty,
          unitPrice: s.sales.unitPrice,
          recordedByMemberId: s.sales.recordedByMemberId,
          occurredAt: s.sales.occurredAt,
        })
        .from(s.sales)
        .where(
          and(
            eq(s.sales.orgId, orgId),
            eq(s.sales.storeId, input.storeId),
            gte(s.sales.occurredAt, from),
            lt(s.sales.occurredAt, toExclusive),
          ),
        )
        .orderBy(desc(s.sales.occurredAt))
        .limit(200);
      return rows;
    });
  }),
});
