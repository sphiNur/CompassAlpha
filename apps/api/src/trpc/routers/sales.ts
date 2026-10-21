/**
 * Sales router (M2.0c, 2026-05-08).
 *
 * Closes the ERP loop: purchase → receive (M2.0a) → menu + BOM
 * (M2.0b) → consume (M2.0c).
 *
 * Three procedures (void added 2026-10-21):
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
 *     per call (covers a busy week per store). Voided sales are
 *     included with their void fields so the UI can strike them out.
 *
 *   void(saleId, reason)
 *     Marks a sale voided and appends positive 'consumption_reversed'
 *     movements mirroring its consumption rows, in one transaction
 *     (migration 0049). Same gate as record. Re-voiding is a no-op.
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

const VoidInputSchema = z.object({
  saleId: UuidSchema,
  /** Why the sale is being voided — kept on the row for the audit trail. */
  reason: z.string().trim().min(1).max(300),
});

/** 2026-10-21: movement source/reason of a sale void's reversal rows. A
 *  distinct source_type keeps the partial UNIQUE index (source_type,
 *  source_id, store_id, sku_id) from colliding with the 'sale' rows. */
export const SALE_VOID_SOURCE_TYPE = 'sale_void';
export const SALE_VOID_REASON = 'consumption_reversed';

/**
 * 2026-10-21: the reversing deltas for a voided sale — one row per SKU,
 * the negation of the summed consumption deltas the sale wrote. Rows that
 * net to zero are dropped. Exported for unit tests.
 */
export function buildSaleReversal(
  consumption: ReadonlyArray<{ skuId: string; delta: string }>,
): Array<{ skuId: string; delta: string }> {
  // Sum in thousandths so 3-decimal deltas don't pick up float drift.
  const bySku = new Map<string, number>();
  for (const row of consumption) {
    const milli = Math.round(Number(row.delta) * 1000);
    bySku.set(row.skuId, (bySku.get(row.skuId) ?? 0) + milli);
  }
  const out: Array<{ skuId: string; delta: string }> = [];
  for (const [skuId, milli] of bySku) {
    if (milli === 0) continue;
    out.push({ skuId, delta: (-milli / 1000).toFixed(3) });
  }
  return out;
}

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

  /**
   * 2026-10-21: void a mistaken sale. Same gate as `record` (sales.record,
   * assigned to the sale's store, per-store override honoured). Marks the
   * row voided and appends reversing movements in ONE transaction; the
   * sale row is locked so two concurrent voids can't both reverse.
   * Already voided → returns ok without writing anything.
   */
  void: authedProcedure.input(VoidInputSchema).mutation(async ({ ctx, input }) => {
    requireSalesRecord(ctx.session!.permissions);
    const orgId = ctx.session!.orgId;
    const sale = await ctx.withOrg((tx) =>
      tx.query.sales.findFirst({
        where: (sl, { eq: eq2, and: and2 }) => and2(eq2(sl.id, input.saleId), eq2(sl.orgId, orgId)),
        columns: { storeId: true },
      }),
    );
    if (!sale) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'sales.errors.saleNotFound' });
    }
    await ctx.withOrg((tx) =>
      assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        sale.storeId,
        ctx.session!.permissions,
      ),
    );
    const effective = await ctx.withOrg((tx) =>
      effectivePermissionsForStore(
        tx,
        ctx.session!.memberId,
        sale.storeId,
        ctx.session!.permissions,
      ),
    );
    requireSalesRecord(effective);

    return ctx.withOrg(async (tx) => {
      // Same rule as record / the inventory ledger guard (CA-54): no
      // ledger writes against an archived or paused store.
      const store = await tx.query.stores.findFirst({
        where: (st, { eq: eq2, and: and2 }) =>
          and2(eq2(st.id, sale.storeId), eq2(st.orgId, orgId)),
        columns: { isActive: true, deletedAt: true },
      });
      if (!store || !store.isActive || store.deletedAt) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'auth.errors.storeArchived' });
      }

      const [locked] = await tx
        .select({ id: s.sales.id, voidedAt: s.sales.voidedAt })
        .from(s.sales)
        .where(and(eq(s.sales.id, input.saleId), eq(s.sales.orgId, orgId)))
        .for('update');
      if (!locked) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'sales.errors.saleNotFound' });
      }
      if (locked.voidedAt) {
        return { ok: true as const, alreadyVoided: true as const, reversed: [] };
      }

      const consumption = await tx
        .select({ skuId: s.inventoryMovements.skuId, delta: s.inventoryMovements.delta })
        .from(s.inventoryMovements)
        .where(
          and(
            eq(s.inventoryMovements.orgId, orgId),
            eq(s.inventoryMovements.storeId, sale.storeId),
            eq(s.inventoryMovements.sourceType, 'sale'),
            eq(s.inventoryMovements.sourceId, input.saleId),
          ),
        );
      const reversal = buildSaleReversal(consumption);
      const now = new Date();
      if (reversal.length > 0) {
        await tx
          .insert(s.inventoryMovements)
          .values(
            reversal.map((r) => ({
              orgId,
              storeId: sale.storeId,
              skuId: r.skuId,
              delta: r.delta,
              reason: SALE_VOID_REASON,
              note: input.reason,
              sourceType: SALE_VOID_SOURCE_TYPE,
              sourceId: input.saleId,
              actorMemberId: ctx.session!.memberId,
              occurredAt: now,
            })),
          )
          .onConflictDoNothing();
      }
      await tx
        .update(s.sales)
        .set({
          voidedAt: now,
          voidedByMemberId: ctx.session!.memberId,
          voidReason: input.reason,
        })
        .where(and(eq(s.sales.id, input.saleId), eq(s.sales.orgId, orgId)));
      return {
        ok: true as const,
        alreadyVoided: false as const,
        reversed: reversal.map(({ skuId, delta }) => ({ skuId, qty: delta })),
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
          // 2026-10-21: voided rows stay in the list (struck through in
          // the UI); the today summary skips them.
          voidedAt: s.sales.voidedAt,
          voidedByMemberId: s.sales.voidedByMemberId,
          voidReason: s.sales.voidReason,
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
