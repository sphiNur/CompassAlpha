/**
 * Run router — event-sourced market run / delivery / confirm flow.
 *
 * Mirrors the order router pattern: load events → decide() → append → project.
 *
 * Run.create has an extra step: it must aggregate all approved order sessions
 * for the date into the planned items list, and emit `AttachedToRun` events
 * on each session stream so they transition to `in_run`.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import {
  AddPurchaserItemInputSchema,
  AddRunExpenseInputSchema,
  ConfirmStoreInputSchema,
  ConfirmStoreItemInputSchema,
  DispatchInputSchema,
  EjectSessionInputSchema,
  MarkUnavailableInputSchema,
  PurchaseItemInputSchema,
  RemoveRunExpenseInputSchema,
  RevisePurchaseInputSchema,
  RunAttachSessionsInputSchema,
  RunCancelInputSchema,
  RunCreateInputSchema,
  RunPreviewInputSchema,
  RunReasonOnlyInputSchema,
  SimpleRunCommandSchema,
  UndeliverStoreInputSchema,
  UndoPurchaseInputSchema,
  UnmarkUnavailableInputSchema,
} from '@compass/contracts';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
  getActorStoreIds,
} from '../../services/storeScope';
import {
  applyRun,
  decideRun,
  emptyRunState,
  type RunEvent,
  type RunState,
} from '@compass/domain/run';
import { decide as decideOrder, apply as applyOrder, emptyState as emptyOrderState, type OrderEvent } from '@compass/domain/order';
import { DomainError } from '@compass/domain';
import { authedProcedure, idempotentMutation, rethrowDomainError, router } from '../trpc';
import { appendEvents, readStream } from '../../services/eventStore';
import { projectRun } from '../../services/runProjection';
import { projectOrder } from '../../services/orderProjection';
import { hub } from '../../realtime/hub';
import { dispatchRunEventNotifications } from '../../services/notifyForEvent';
import { todayInTz } from '@compass/domain';

/**
 * Today as YYYY-MM-DD in the session's ORG timezone. D.1 (M3.39,
 * 2026-05-20) — was UTC-only, which caused new runs created between
 * 00:00 and (org-offset) UTC to land under yesterday's runDate key
 * for UZ tenants. Same helper shape as order.ts:todayInOrgTz.
 */
function todayStr(ctx: { session: { orgTimezone: string } | null }): string {
  return todayInTz(ctx.session?.orgTimezone ?? 'UTC');
}

export const runRouter = router({
  expenseTemplates: authedProcedure.query(async ({ ctx }) => {
    const perms = ctx.session!.permissions;
    if (!perms.has('run.purchase') && !perms.has('users.manage') && !perms.has('org.admin')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'auth.errors.missingPermission',
        cause: { missingPermission: 'run.purchase' },
      });
    }
    return ctx.withOrg(async (tx) =>
      tx
        .select({
          id: s.expenseTemplates.id,
          label: s.expenseTemplates.label,
          unitHint: s.expenseTemplates.unitHint,
          defaultQty: s.expenseTemplates.defaultQty,
          defaultUnitPrice: s.expenseTemplates.defaultUnitPrice,
          defaultPaymentMethod: s.expenseTemplates.defaultPaymentMethod,
          sortIndex: s.expenseTemplates.sortIndex,
        })
        .from(s.expenseTemplates)
        .where(
          and(
            eq(s.expenseTemplates.orgId, ctx.session!.orgId),
            eq(s.expenseTemplates.isArchived, false),
          ),
        )
        .orderBy(s.expenseTemplates.sortIndex, s.expenseTemplates.createdAt),
    );
  }),

  /**
   * Preview what `create` would plan for a given date.
   *
   * SCOPE (revised M3.2, 2026-05-15) — TWO modes:
   *
   *   - ORG-WIDE: actor holds `run.create.org` OR `users.manage`
   *     (admins, super_admins, head_purchaser custom role). Returns
   *     every approved session for the date across the org. This is
   *     the "one purchaser walks the bazaar for the whole chain"
   *     path the original design assumed.
   *
   *   - STORE-SCOPED: every other actor (purchaser role bound to N
   *     specific stores, store managers, etc.). Returns only sessions
   *     in stores the actor is bound to via MSA or store-scoped role
   *     binding. A purchaser bound to Stores A+B cannot see Store C's
   *     demand — they have no authority to buy for C, so showing it
   *     would leak demand data across stores.
   *
   * Earlier the comment here said "INTENTIONALLY org-wide" without
   * distinguishing roles. The pre-launch architecture audit (M3.1
   * findings) showed that purchasers are seeded as store-tier (rank
   * 40, scope_type='store' enforced at grant time) yet the query
   * ignored their binding. The fix introduces `run.create.org` as
   * the explicit opt-in for org-wide visibility; anyone without it
   * gets the per-binding view.
   *
   * Returns three layers of aggregation so the FE can offer the user
   * an overall / per-store / per-supplier toggle on the same payload
   * without round-trips (M1.5, 2026-05-06):
   *
   *   - `plannedItems` (legacy)  — flat sum across stores, one row per
   *                                SKU. Powers the "overall" view.
   *   - `perStoreDemand`         — per (store, sku) sum + the store's
   *                                display name. Powers "by store"
   *                                view (each store's preparation
   *                                list) and is also re-pivoted client-
   *                                side for the per-supplier view's
   *                                "Store A: X kg, Store B: Y kg"
   *                                breakdown under each item.
   *   - `supplierBySku`          — preferred supplier per SKU drawn
   *                                from `sku_supplier_links`,
   *                                preferring `is_preferred=true`,
   *                                tiebreak by `last_seen_at DESC`.
   *                                SKUs with no link land under a
   *                                synthetic "unassigned" bucket on
   *                                the FE.
   */
  previewCreatable: authedProcedure
    .input(RunPreviewInputSchema)
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        // M3.24-fix (2026-05-18): when caller omits `date`, return EVERY
        // approved session that hasn't been attached to a run yet —
        // regardless of order_date. Old behavior was "default to today
        // (UTC)", which left approved-yesterday sessions invisible to
        // the purchaser once the server's UTC date rolled over (the
        // known org-tz issue order.ts:48 calls out). Explicit `date`
        // arg still narrows to that day. status='approved' already
        // implies run_id IS NULL because the projector clears run_id
        // only on Approved → in_run / archived transitions.
        const date = input.date ?? null;
        // M3.2: org-wide visibility requires `run.create.org` (or the
        // legacy `users.manage` super-perm). Without it, scope the
        // query to the actor's bound stores. `getActorStoreIds`
        // returns `null` for org-tier actors (skip filter), an
        // explicit array for store-tier actors.
        const allowedStoreIds = ctx.session!.permissions.has('run.create.org')
          ? null
          : await getActorStoreIds(
              tx,
              ctx.session!.memberId,
              ctx.session!.permissions,
            );
        const sessions = await tx.query.orderSessionsV.findMany({
          where: (sess, { eq: eq2, and: and2, inArray: inArray2 }) => {
            const base = [
              eq2(sess.orgId, ctx.session!.orgId),
              eq2(sess.status, 'approved'),
            ];
            if (date !== null) base.push(eq2(sess.orderDate, date));
            // null = unrestricted (org-tier actor). Empty array = actor
            // has no stores anywhere → return zero sessions without a
            // SQL parameter error (Drizzle's inArray on [] is a no-op
            // that matches everything, so we must guard here).
            if (allowedStoreIds !== null) {
              if (allowedStoreIds.length === 0) {
                // Sentinel that can never match — a fresh UUID.
                base.push(eq2(sess.storeId, '00000000-0000-0000-0000-000000000000'));
              } else {
                base.push(inArray2(sess.storeId, allowedStoreIds));
              }
            }
            return and2(...base);
          },
        });
        const sessionIds = sessions.map((s) => s.id);
        if (sessionIds.length === 0) {
          return {
            date,
            sessions: [],
            plannedItems: [],
            perStoreDemand: [],
            supplierBySku: {} as Record<string, {
              id: string;
              name: string;
              contactPhone: string | null;
              contactTg: string | null;
              defaultPrice: string | null;
              lastSeenPrice: string | null;
              estimatedUnitPrice: string | null;
            } | null>,
            lastPurchasePriceBySku: {} as Record<string, string>,
            perStoreBudgets: [] as Array<{
              storeId: string;
              storeName: string;
              estimatedTotal: string;
              unknownPriceCount: number;
            }>,
            sessionNotesByStore: {} as Record<string, string>,
            total: 0,
          };
        }
        const items = await tx.query.orderItemsV.findMany({
          where: (it, { inArray: inArray2 }) => inArray2(it.sessionId, sessionIds),
        });

        // Build a session.id → storeId lookup so we can pivot items by
        // store. Cheaper than re-joining at the SQL level for the small
        // session counts (≤ a few dozen) we expect today.
        const storeBySession = new Map<string, string>();
        for (const sess of sessions) storeBySession.set(sess.id, sess.storeId);

        const aggregated = new Map<string, number>();
        const perStoreSkuQty = new Map<string, Map<string, number>>(); // storeId → skuId → qty
        for (const it of items) {
          const qty = Number(it.qty);
          if (qty <= 0) continue;
          aggregated.set(it.skuId, (aggregated.get(it.skuId) ?? 0) + qty);
          const sid = storeBySession.get(it.sessionId);
          if (!sid) continue;
          const inner = perStoreSkuQty.get(sid) ?? new Map<string, number>();
          inner.set(it.skuId, (inner.get(it.skuId) ?? 0) + qty);
          perStoreSkuQty.set(sid, inner);
        }

        // Resolve store display names in one query — the FE renders
        // "🏪 {name}" headings so we'd otherwise need session.stores
        // (which only covers the actor's accessible stores). For an
        // admin viewing an org-wide preview we want every involved
        // store's name, not just theirs.
        const involvedStoreIds = [
          ...new Set([...perStoreSkuQty.keys(), ...sessions.map((s) => s.storeId)]),
        ];
        // M1.9-fix (2026-05-07): drizzle's tagged template binds a JS
        // array as a single parameter — `IN ${array}` becomes
        // `IN ($1)` with $1 being the entire array, not an IN-list.
        // Postgres compares the UUID column to the text representation
        // of the array and returns no rows; storeName silently became
        // '—' for every store on the by-store preview. Use the
        // `inArray()` builder, which expands to a proper IN-list.
        const storeRows = involvedStoreIds.length
          ? await tx
              .select({ id: s.stores.id, name: s.stores.name })
              .from(s.stores)
              .where(inArray(s.stores.id, involvedStoreIds))
          : [];
        const storeNameById = new Map(storeRows.map((r) => [r.id, r.name]));

        const perStoreDemand: Array<{
          storeId: string;
          storeName: string;
          skuId: string;
          qty: string;
        }> = [];
        for (const [sid, inner] of perStoreSkuQty.entries()) {
          const storeName = storeNameById.get(sid) ?? '—';
          for (const [skuId, qty] of inner.entries()) {
            perStoreDemand.push({
              storeId: sid,
              storeName,
              skuId,
              qty: qty.toString(),
            });
          }
        }

        // Resolve preferred supplier per SKU. DISTINCT ON (sku_id) +
        // ORDER BY is_preferred DESC, last_seen_at DESC NULLS LAST
        // gives us "the best link per SKU". Only one query for all
        // planned SKUs.
        const skuIds = [...aggregated.keys()];
        const supplierBySku: Record<string, {
          id: string;
          name: string;
          contactPhone: string | null;
          contactTg: string | null;
          defaultPrice: string | null;
          lastSeenPrice: string | null;
          estimatedUnitPrice: string | null;
        } | null> = {};
        // Budgeting must not depend on a SKU having a preferred supplier.
        // The most recent real purchase is the best reference price for a
        // purchaser deciding today's branch budget, regardless of where it
        // was bought. Preferred-supplier defaults remain useful for vendor
        // grouping, but must not turn a priced SKU into “unknown price”.
        const lastPurchasePriceBySku: Record<string, string> = {};
        if (skuIds.length > 0) {
          // Drizzle ORM doesn't have a clean `distinctOn` builder; use
          // `sql` raw for the prioritised ranking. Casting through
          // `any` for the row shape — we know what columns we asked
          // for.
          // M1.7-fix (2026-05-06): require is_preferred=true. Earlier
          // version sorted by `is_preferred DESC, last_seen_at DESC`
          // and took DISTINCT ON, which silently returned a "best
          // available" supplier even when ALL links for the SKU had
          // is_preferred=false. That broke the user-clears-supplier
          // flow: setSkuPreferredSupplier(null) wipes is_preferred to
          // false on every link, but the preview kept showing the
          // most-recent link as if it were still preferred.
          //
          // With WHERE is_preferred=true, a SKU with no preferred
          // link returns no row → falls into the FE's "Unassigned"
          // bucket, which matches the operator's mental model
          // ("I cleared it, so it's gone").
          const rows = await tx.execute<{
            sku_id: string;
            supplier_id: string;
            name: string;
            contact_phone: string | null;
            contact_tg: string | null;
            default_price: string | null;
            last_seen_price: string | null;
          }>(sql`
            SELECT DISTINCT ON (sl.sku_id)
              sl.sku_id, sl.supplier_id,
              sup.name, sup.contact_phone, sup.contact_tg,
              sl.default_price::text AS default_price,
              sl.last_seen_price::text AS last_seen_price
            FROM inventory.sku_supplier_links sl
            INNER JOIN inventory.suppliers sup ON sup.id = sl.supplier_id
            WHERE sl.sku_id IN ${skuIds}
              AND sup.is_archived = false
              AND sl.is_preferred = true
            ORDER BY sl.sku_id,
                     sl.last_seen_at DESC NULLS LAST
          `);
          // node-postgres returns rows under `.rows` for raw SQL; the
          // drizzle execute() result is already an array on Postgres
          // adapters but we defensively support both shapes.
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: typeof rows }).rows ?? []);
          for (const r of list) {
            supplierBySku[r.sku_id] = {
              id: r.supplier_id,
              name: r.name,
              contactPhone: r.contact_phone,
              contactTg: r.contact_tg,
              defaultPrice: r.default_price,
              lastSeenPrice: r.last_seen_price,
              estimatedUnitPrice: r.default_price ?? r.last_seen_price,
            };
          }
          // SKUs with no link → null entry, so the FE can still show a
          // bucket for them rather than dropping them silently.
          for (const sid of skuIds) {
            if (!(sid in supplierBySku)) supplierBySku[sid] = null;
          }

          const priceRows = await tx.execute<{
            sku_id: string;
            unit_price: string;
          }>(sql`
            SELECT DISTINCT ON (ph.sku_id)
              ph.sku_id::text AS sku_id,
              ph.unit_price::text AS unit_price
            FROM inventory.price_history ph
            WHERE ph.org_id = ${ctx.session!.orgId}
              AND ph.sku_id IN (${sql.raw(skuIds.map((id) => `'${id}'`).join(','))})
            ORDER BY ph.sku_id, ph.observed_at DESC, ph.created_at DESC
          `);
          const prices = Array.isArray(priceRows)
            ? priceRows
            : ((priceRows as { rows?: typeof priceRows }).rows ?? []);
          for (const price of prices) {
            lastPurchasePriceBySku[price.sku_id] = price.unit_price;
          }
        }

        // M1.8 (2026-05-07): bundle the session-level "其他物品" notes
        // by store so the FE can show them inline next to that store's
        // demand block. Per-store concat with separators for legibility.
        //
        // M3.16-C (2026-05-16): also bundle structured `extras`. Both
        // surfaces are emitted so the FE can render whichever the user
        // typed (pre-M3.16 sessions = notes string, new sessions =
        // extras array). Eventually `notes` drops once no live sessions
        // carry the legacy text.
        //
        // M3.37 (2026-05-19, Wave2 #5): each extra now carries
        // `sessionId` + `idx` + optional `status` so the FE can route
        // a tap into the `order.markExtraStatus` mutation. Without
        // sessionId/idx the flattened per-store list was unaddressable.
        type ExtraItem = {
          name: string;
          qty: string;
          unit: string;
          note?: string;
          status?: 'pending' | 'bought' | 'unavailable';
          sessionId: string;
          idx: number;
        };
        const notesByStore = new Map<string, string[]>();
        const extrasByStore = new Map<string, ExtraItem[]>();
        for (const sess of sessions) {
          const trimmed = (sess.notes ?? '').trim();
          if (trimmed) {
            const arr = notesByStore.get(sess.storeId) ?? [];
            arr.push(trimmed);
            notesByStore.set(sess.storeId, arr);
          }
          const sessionExtras = (sess.extrasJson ?? []) as Array<{
            name: string;
            qty: string;
            unit: string;
            note?: string;
            status?: 'pending' | 'bought' | 'unavailable';
          }>;
          if (sessionExtras.length > 0) {
            const arr = extrasByStore.get(sess.storeId) ?? [];
            for (let i = 0; i < sessionExtras.length; i++) {
              const ex = sessionExtras[i]!;
              arr.push({ ...ex, sessionId: sess.id, idx: i });
            }
            extrasByStore.set(sess.storeId, arr);
          }
        }
        const sessionNotesByStore: Record<string, string> = {};
        for (const [sid, arr] of notesByStore.entries()) {
          sessionNotesByStore[sid] = arr.join('\n\n');
        }
        const sessionExtrasByStore: Record<string, ExtraItem[]> = {};
        for (const [sid, arr] of extrasByStore.entries()) {
          sessionExtrasByStore[sid] = arr;
        }

        const perStoreBudgets = involvedStoreIds.map((storeId) => {
          let estimatedTotal = 0;
          let unknownPriceCount = 0;
          for (const [skuId, qty] of perStoreSkuQty.get(storeId)?.entries() ?? []) {
            const estimatedUnitPrice =
              lastPurchasePriceBySku[skuId] ??
              supplierBySku[skuId]?.estimatedUnitPrice ??
              null;
            if (!estimatedUnitPrice) {
              unknownPriceCount += 1;
              continue;
            }
            estimatedTotal += Number(qty) * Number(estimatedUnitPrice);
          }
          return {
            storeId,
            storeName: storeNameById.get(storeId) ?? '—',
            estimatedTotal: estimatedTotal.toFixed(2),
            unknownPriceCount,
          };
        });

        return {
          date,
          sessions: sessions.map((s) => ({
            id: s.id,
            storeId: s.storeId,
            storeName: storeNameById.get(s.storeId) ?? '—',
            orderDate: s.orderDate,
            submittedByMemberId: s.submittedByMemberId,
            notes: s.notes,
            extras: (s.extrasJson ?? []) as ExtraItem[],
          })),
          plannedItems: [...aggregated.entries()].map(([skuId, qty]) => ({
            skuId,
            qty: qty.toString(),
          })),
          perStoreDemand,
          supplierBySku,
          lastPurchasePriceBySku,
          perStoreBudgets,
          /** Per-store concatenated session notes (M1.8, legacy). Empty
           *  record when no notes anywhere. */
          sessionNotesByStore,
          /** Per-store structured extras (M3.16-C). Empty record when
           *  no extras anywhere. */
          sessionExtrasByStore,
          total: aggregated.size,
        };
      });
    }),

  /**
   * Manual supplier (re-)assignment from the Run preview (M1.6 #1,
   * 2026-05-06).
   *
   * Use case: the purchaser is staring at the "by supplier" preview
   * and notices a SKU with the wrong vendor (or none). They tap the
   * SKU, pick the right vendor from the org's supplier list, the
   * preview re-aggregates immediately. Decisions stick across runs
   * because we update `sku_supplier_links.is_preferred`.
   *
   * Idempotent on `(skuId, supplierId)`. Setting supplierId=null
   * clears the preferred flag from every link of that SKU (preview
   * will then show the SKU under "Unassigned vendor").
   *
   * Permission: `run.purchase` — anyone running a market run can
   * keep the preference table fresh. Admins also have this perm via
   * the manager role tier. We intentionally don't gate this on
   * `users.manage` because the field crew is the one who learns
   * "stall A doesn't carry tomatoes anymore" first.
   */
  setSkuPreferredSupplier: authedProcedure
    .input(
      z.object({
        skuId: z.string().uuid(),
        supplierId: z.string().uuid().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.session?.permissions.has('run.purchase')) {
        // M1.9-extra (P7): drop the colon-suffix; missing perm in cause.
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.missingPermission',
          cause: { missingPermission: 'run.purchase' },
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;

        // Cross-tenant guard. Both the SKU and (if given) the supplier
        // must belong to the actor's org. Without this an actor in
        // org A could pivot a SKU's preferred vendor to a supplier
        // from org B by passing its UUID — leaks the supplier's
        // existence and creates a dangling reference.
        const sku = await tx.query.skus.findFirst({
          where: (k, { eq: eq2, and: and2 }) =>
            and2(eq2(k.id, input.skuId), eq2(k.orgId, orgId)),
        });
        if (!sku) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.skuNotFound' });
        }
        if (input.supplierId !== null) {
          const sup = await tx.query.suppliers.findFirst({
            where: (su, { eq: eq2, and: and2 }) =>
              and2(eq2(su.id, input.supplierId!), eq2(su.orgId, orgId)),
          });
          if (!sup) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'admin.errors.supplierNotFound',
            });
          }
        }

        // Reset is_preferred on every existing link for this SKU.
        // After this, ZERO links are preferred for this SKU. We then
        // re-set just the chosen one (if any) below. Two-step keeps
        // the invariant "at most one preferred per SKU" without
        // needing a unique partial index.
        await tx
          .update(s.skuSupplierLinks)
          .set({ isPreferred: false })
          .where(eq(s.skuSupplierLinks.skuId, input.skuId));

        if (input.supplierId !== null) {
          // Upsert the chosen link with is_preferred=true. ON CONFLICT
          // updates the existing row (preserves price observations);
          // INSERT creates one if it didn't exist before.
          await tx
            .insert(s.skuSupplierLinks)
            .values({
              skuId: input.skuId,
              supplierId: input.supplierId,
              isPreferred: true,
              lastSeenAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [s.skuSupplierLinks.skuId, s.skuSupplierLinks.supplierId],
              set: { isPreferred: true, lastSeenAt: new Date() },
            });
        }
        return { ok: true };
      });
    }),

  /**
   * Plan a run from approved sessions on a given date.
   *
   * Scope (M3.2): two modes, mirroring `previewCreatable`:
   *
   *   - org-tier actor (`run.create.org` or `users.manage`):
   *     can include sessions from ANY store in the org. This is
   *     the head-purchaser path — one buyer walks the bazaar for
   *     the whole chain.
   *
   *   - store-tier actor (purchaser bound to specific stores):
   *     every session in `input.sessionIds` MUST belong to a store
   *     the actor is bound to. If even one session is outside their
   *     scope the entire create is rejected — partial runs would be
   *     surprising. The check is precise: an attacker who guessed
   *     a Store B session UUID gets `auth.errors.notAssignedToStore`
   *     instead of silently slipping into the run.
   */
  // M1.20: idempotent — FE sends X-Idempotency-Key per logical
  // "create run" action so network retry doesn't create two runs.
  create: idempotentMutation.input(RunCreateInputSchema).mutation(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const date = input.date ?? todayStr(ctx);
      // Determine next runIndex for the day (re-runs produce runIndex=1, 2, ...).
      const existing = await tx.query.marketRunsV.findMany({
        where: (r, { eq: eq2, and: and2 }) =>
          and2(eq2(r.orgId, ctx.session!.orgId), eq2(r.runDate, date)),
        orderBy: (r, { desc }) => desc(r.runIndex),
      });
      const runIndex = existing.length === 0 ? 0 : existing[0]!.runIndex + 1;

      // Verify sessions exist, are approved, and aren't already in a run.
      const sessions = await tx.query.orderSessionsV.findMany({
        where: (sess, { eq: eq2, and: and2, inArray: inArray2 }) =>
          and2(eq2(sess.orgId, ctx.session!.orgId), inArray2(sess.id, input.sessionIds)),
      });
      if (sessions.length !== input.sessionIds.length) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.sessionMissing' });
      }
      for (const sess of sessions) {
        if (sess.status !== 'approved') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'run.errors.sessionNotApproved',
          });
        }
      }
      // M3.2: store-scope check. Skip for org-tier actors. For
      // everyone else, every targeted session's storeId must be in
      // the actor's bound set. We reject the WHOLE create — partial
      // runs would leave the FE in a weird state and the audit log
      // would record an attempt to plan cross-store without auth.
      if (!ctx.session!.permissions.has('run.create.org')) {
        const allowedStoreIds = await getActorStoreIds(
          tx,
          ctx.session!.memberId,
          ctx.session!.permissions,
        );
        // `null` from getActorStoreIds means unrestricted (admin path).
        // We only enforce when we got a concrete list back.
        if (allowedStoreIds !== null) {
          const allowed = new Set(allowedStoreIds);
          for (const sess of sessions) {
            if (!allowed.has(sess.storeId)) {
              throw new TRPCError({
                code: 'FORBIDDEN',
                message: 'auth.errors.notAssignedToStore',
              });
            }
          }
        }
      }

      // Aggregate items across sessions.
      const items = await tx.query.orderItemsV.findMany({
        where: (it, { inArray: inArray2 }) => inArray2(it.sessionId, input.sessionIds),
      });
      const aggregated = new Map<string, number>();
      for (const it of items) {
        const qty = Number(it.qty);
        if (qty <= 0) continue;
        aggregated.set(it.skuId, (aggregated.get(it.skuId) ?? 0) + qty);
      }
      const plannedItems = [...aggregated.entries()].map(([skuId, qty]) => ({
        skuId,
        qty: qty.toString(),
      }));

      const runId = randomUUID();
      const state = emptyRunState(runId);
      let events: RunEvent[] = [];
      try {
        events = decideRun(state, {
          type: 'PlanRun',
          orgId: ctx.session!.orgId,
          runDate: date,
          runIndex,
          sessionIds: input.sessionIds,
          plannedItems,
          actor: {
            userId: ctx.session!.userId,
            memberId: ctx.session!.memberId,
            permissions: ctx.session!.permissions,
          },
        });
        // M1.13 (2026-05-08): atomic plan + start. The FE collapsed
        // the "+ New run" / "Start purchase" double-tap. Fold the
        // PlanRun events forward, then ask the aggregate to emit
        // StartPurchase against that fresh state. Both event sets
        // commit in the same DB transaction below — projection lag
        // never sees a half-state. Single-step callers (older clients
        // and tests) still get the original two-event flow.
        if (input.startImmediately) {
          let folded = state;
          for (const e of events) folded = applyRun(folded, e);
          const startEvents = decideRun(folded, {
            type: 'StartPurchase',
            actor: {
              userId: ctx.session!.userId,
              memberId: ctx.session!.memberId,
              permissions: ctx.session!.permissions,
            },
          });
          events = events.concat(startEvents);
        }
      } catch (err) {
        if (err instanceof DomainError) rethrowDomainError(err);
        throw err;
      }

      // 2026-06-08: templates are manual shortcuts, not automatic
      // daily costs. Real extra expenses vary by business date and
      // store, so a new run must not silently inherit template rows.

      try {
        await appendEvents(tx, {
          streamType: 'run',
          streamId: runId,
          orgId: ctx.session!.orgId,
          events: events.map((e) => ({
            type: e.type,
            seq: e.seq,
            payload: e.payload,
            actorUserId: e.actorUserId,
            actorMemberId: e.actorMemberId,
            occurredAt: e.occurredAt,
          })),
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'run.errors.alreadyPlanned' });
        }
        throw err;
      }
      await projectRun(tx, ctx.session!.orgId, events);

      // Emit AttachedToRun on each session stream.
      const attachedSessions: Array<{ sessionId: string; lastSeq: number }> = [];
      for (const sessionId of input.sessionIds) {
        const orderEvents = (await readStream(tx, 'order', sessionId)) as unknown as OrderEvent[];
        let oState = emptyOrderState(sessionId);
        for (const e of orderEvents) oState = applyOrder(oState, e);
        const ev = decideOrder(oState, {
          type: 'AttachToRun',
          runId,
          actor: {
            userId: ctx.session!.userId,
            memberId: ctx.session!.memberId,
            permissions: ctx.session!.permissions,
            isClaimer: oState.claimedByMemberId === ctx.session!.memberId,
          },
        });
        if (ev.length > 0) {
          await appendEvents(tx, {
            streamType: 'order',
            streamId: sessionId,
            orgId: ctx.session!.orgId,
            events: ev.map((e) => ({ ...e })),
          });
          await projectOrder(tx, ctx.session!.orgId, ev);
          attachedSessions.push({
            sessionId,
            lastSeq: ev[ev.length - 1]?.seq ?? oState.seq,
          });
        }
      }

      // 2026-07-26: run.create was the only run mutation that broadcast
      // nothing — compare attachSessions / ejectSession / purchaseItem,
      // which all publish here. Two visible consequences:
      //
      //   - a second purchaser's client had no idea a run existed until
      //     its next 6s poll;
      //   - the store staff whose approved orders this call just LOCKED
      //     (AttachToRun makes them uneditable and un-unapprovable) got
      //     no order.changed at all, so their Order/Approval screens
      //     kept offering actions the server would now reject.
      //
      // Deliberately NOT calling dispatchRunEventNotifications here:
      // that sends real Telegram messages, and "should creating a run
      // notify everyone" is a product decision, not a missing-broadcast
      // bug. Left for whoever wants that behaviour to choose it.
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId,
        lastSeq: events[events.length - 1]?.seq ?? 0,
      });
      for (const a of attachedSessions) {
        hub.publish(ctx.session!.orgId, {
          type: 'order.changed',
          orgId: ctx.session!.orgId,
          sessionId: a.sessionId,
          lastSeq: a.lastSeq,
        });
      }

      return { runId, runIndex, lastSeq: events[events.length - 1]?.seq ?? 0 };
    });
  }),

  /**
   * M3.31 A.2 (2026-05-18): attach additional approved sessions to a
   * live run. Allowed while the run is `planned` or `purchasing`.
   *
   * The mutation mirrors `create` in shape — aggregate the new sessions'
   * orderItemsV rows into a delta, emit `SessionsAttachedToRun` on the
   * run stream, then `AttachedToRun` on each session stream so the
   * session transitions from `approved` to `in_run` and stops appearing
   * in `previewCreatable`. Store-scope guard runs on every new session
   * (same as `create`) — a store-tier purchaser can only attach
   * sessions from stores they're bound to.
   */
  attachSessions: idempotentMutation
    .input(RunAttachSessionsInputSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const run = await loadRun(tx, ctx.session!.orgId, input.runId);
        if (run.status !== 'planned' && run.status !== 'purchasing') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'run.errors.cannotAttachInStatus',
          });
        }
        const alreadyIn = new Set((run.sessionIdsJson ?? []) as string[]);
        const dedupedNewIds = input.sessionIds.filter((id) => !alreadyIn.has(id));
        if (dedupedNewIds.length === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'run.errors.allSessionsAlreadyInRun',
          });
        }
        const sessions = await tx.query.orderSessionsV.findMany({
          where: (sess, { eq: eq2, and: and2, inArray: inArray2 }) =>
            and2(eq2(sess.orgId, ctx.session!.orgId), inArray2(sess.id, dedupedNewIds)),
        });
        if (sessions.length !== dedupedNewIds.length) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.sessionMissing' });
        }
        for (const sess of sessions) {
          if (sess.status !== 'approved') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'run.errors.sessionNotApproved',
            });
          }
        }
        // Store-scope: same gate as create. Org-tier (`run.create.org`)
        // bypasses; store-tier purchasers can only attach from their
        // bound stores.
        if (!ctx.session!.permissions.has('run.create.org')) {
          const allowedStoreIds = await getActorStoreIds(
            tx,
            ctx.session!.memberId,
            ctx.session!.permissions,
          );
          if (allowedStoreIds !== null) {
            const allowed = new Set(allowedStoreIds);
            for (const sess of sessions) {
              if (!allowed.has(sess.storeId)) {
                throw new TRPCError({
                  code: 'FORBIDDEN',
                  message: 'auth.errors.notAssignedToStore',
                });
              }
            }
          }
        }

        // Aggregate items across the new sessions only — these become
        // the delta. The run state reducer merges them on top of
        // whatever's already planned.
        const items = await tx.query.orderItemsV.findMany({
          where: (it, { inArray: inArray2 }) => inArray2(it.sessionId, dedupedNewIds),
        });
        const aggregated = new Map<string, number>();
        for (const it of items) {
          const qty = Number(it.qty);
          if (qty <= 0) continue;
          aggregated.set(it.skuId, (aggregated.get(it.skuId) ?? 0) + qty);
        }
        const addedPlannedItems = [...aggregated.entries()].map(([skuId, qty]) => ({
          skuId,
          qty: qty.toString(),
        }));

        // Replay the run aggregate, then decide AttachSessions.
        const runEvents = (await readStream(tx, 'run', run.id)) as unknown as RunEvent[];
        let runState = emptyRunState(run.id);
        for (const e of runEvents) runState = applyRun(runState, e);
        let producedEvents: RunEvent[];
        try {
          producedEvents = decideRun(runState, {
            type: 'AttachSessions',
            sessionIds: dedupedNewIds,
            addedPlannedItems,
            actor: actorFromCtx(ctx),
          });
        } catch (err) {
          if (err instanceof DomainError) rethrowDomainError(err);
          throw err;
        }
        await appendEvents(tx, {
          streamType: 'run',
          streamId: run.id,
          orgId: ctx.session!.orgId,
          events: producedEvents.map((e) => ({
            type: e.type,
            seq: e.seq,
            payload: e.payload,
            actorUserId: e.actorUserId,
            actorMemberId: e.actorMemberId,
            occurredAt: e.occurredAt,
          })),
        });
        await projectRun(tx, ctx.session!.orgId, producedEvents);

        // Move each attached session's stream from approved → in_run.
        for (const sessionId of dedupedNewIds) {
          const orderEvents = (await readStream(tx, 'order', sessionId)) as unknown as OrderEvent[];
          let oState = emptyOrderState(sessionId);
          for (const e of orderEvents) oState = applyOrder(oState, e);
          const ev = decideOrder(oState, {
            type: 'AttachToRun',
            runId: run.id,
            actor: {
              userId: ctx.session!.userId,
              memberId: ctx.session!.memberId,
              permissions: ctx.session!.permissions,
              isClaimer: oState.claimedByMemberId === ctx.session!.memberId,
            },
          });
          if (ev.length > 0) {
            await appendEvents(tx, {
              streamType: 'order',
              streamId: sessionId,
              orgId: ctx.session!.orgId,
              events: ev.map((e) => ({ ...e })),
            });
            await projectOrder(tx, ctx.session!.orgId, ev);
          }
        }

        return {
          runId: run.id,
          attached: dedupedNewIds,
          lastSeq: producedEvents[producedEvents.length - 1]?.seq ?? runState.seq,
        };
      });
    }),

  list: authedProcedure.query(async ({ ctx }) => {
    return ctx.withOrg(async (tx) => {
      // M3.33 (2026-05-18, Wave1 #2): store-scope filter. Org-tier
      // (run.create.org / users.manage) sees every run in the org.
      // Store-tier actors only see runs that touch a store they're
      // bound to. Without this, a single-store manager could enumerate
      // every other store's run-level metadata (runDate, sessionIds,
      // purchaser, totals).
      const allowedStoreIds = ctx.session!.permissions.has('run.create.org')
        ? null
        : await getActorStoreIds(
            tx,
            ctx.session!.memberId,
            ctx.session!.permissions,
          );
      const runs = await tx
        .select()
        .from(s.marketRunsV)
        .where(eq(s.marketRunsV.orgId, ctx.session!.orgId))
        .orderBy(desc(s.marketRunsV.runDate), desc(s.marketRunsV.runIndex))
        .limit(50);
      let visibleRuns = runs;
      if (allowedStoreIds !== null && allowedStoreIds.length === 0) return [];
      // Resolve every involved storeId in one shot; cheap join on a
      // bounded result set. Filter runs whose sessions touch any
      // allowed store.
      const allSessionIds = [
        ...new Set(runs.flatMap((r) => (r.sessionIdsJson as unknown as string[]) ?? [])),
      ];
      const allowedStoreSet = allowedStoreIds === null ? null : new Set(allowedStoreIds);
      if (allowedStoreSet) {
        if (allSessionIds.length === 0) return [];
        const sessionStoreRows = await tx.query.orderSessionsV.findMany({
          where: (sess, { inArray }) => inArray(sess.id, allSessionIds),
          columns: { id: true, storeId: true },
        });
        const sessionStore = new Map(sessionStoreRows.map((r) => [r.id, r.storeId]));
        visibleRuns = runs.filter((r) => {
          const ids = (r.sessionIdsJson as unknown as string[]) ?? [];
          return ids.some((sid) => {
            const storeId = sessionStore.get(sid);
            return storeId !== undefined && allowedStoreSet.has(storeId);
          });
        });
      }
      if (visibleRuns.length === 0) return [];

      type MutableStoreTotal = {
        storeId: string;
        total: number;
        cash: number;
        transfer: number;
        skuIds: Set<string>;
      };
      const totalsByRun = new Map<string, Map<string, MutableStoreTotal>>();
      const ensureStoreTotal = (runId: string, storeId: string): MutableStoreTotal | null => {
        if (allowedStoreSet && !allowedStoreSet.has(storeId)) return null;
        let runTotals = totalsByRun.get(runId);
        if (!runTotals) {
          runTotals = new Map<string, MutableStoreTotal>();
          totalsByRun.set(runId, runTotals);
        }
        let cur = runTotals.get(storeId);
        if (!cur) {
          cur = {
            storeId,
            total: 0,
            cash: 0,
            transfer: 0,
            skuIds: new Set<string>(),
          };
          runTotals.set(storeId, cur);
        }
        return cur;
      };
      const visibleRunIds = visibleRuns.map((r) => r.id);

      const splitRows = await tx
        .select({
          runId: s.runItemStoresV.runId,
          storeId: s.runItemStoresV.storeId,
          skuId: s.runItemStoresV.skuId,
          qty: s.runItemStoresV.qty,
          itemUnitPrice: s.runItemsV.unitPrice,
          itemPaymentMethod: s.runItemsV.paymentMethod,
          splitUnitPrice: s.runItemStoresV.unitPrice,
          splitPaymentMethod: s.runItemStoresV.paymentMethod,
        })
        .from(s.runItemStoresV)
        .innerJoin(
          s.runItemsV,
          and(
            eq(s.runItemsV.runId, s.runItemStoresV.runId),
            eq(s.runItemsV.skuId, s.runItemStoresV.skuId),
          ),
        )
        .where(
          and(
            inArray(s.runItemStoresV.runId, visibleRunIds),
            eq(s.runItemsV.status, 'purchased'),
          ),
        );
      for (const row of splitRows) {
        const unitPrice = row.splitUnitPrice ?? row.itemUnitPrice;
        if (!unitPrice) continue;
        const subtotal = Number(row.qty) * Number(unitPrice);
        if (!Number.isFinite(subtotal)) continue;
        const cur = ensureStoreTotal(row.runId, row.storeId);
        if (!cur) continue;
        cur.total += subtotal;
        if ((row.splitPaymentMethod ?? row.itemPaymentMethod) === 'transfer') cur.transfer += subtotal;
        else cur.cash += subtotal;
        cur.skuIds.add(row.skuId);
      }

      const moneyString = (n: number) => (Math.round(n * 100) / 100).toString();
      return visibleRuns.map((run) => ({
        ...run,
        storeTotals: [...(totalsByRun.get(run.id)?.values() ?? [])]
          .sort((a, b) => b.total - a.total)
          .map((total) => ({
            storeId: total.storeId,
            total: moneyString(total.total),
            cash: moneyString(total.cash),
            transfer: moneyString(total.transfer),
            itemCount: total.skuIds.size,
          })),
      }));
    });
  }),

  /**
   * Complete finished-run history for the purchaser-facing history page.
   * `list` deliberately stays compact for the live procurement screen;
   * this endpoint is independently bounded and only returns finished runs
   * so several months of records do not turn the active page into an
   * endless scroll.
   */
  history: authedProcedure
    .input(z.object({ limit: z.number().int().min(25).max(1000).default(100) }).optional())
    .query(async ({ ctx, input }) =>
      ctx.withOrg(async (tx) => {
        const allowedStoreIds = ctx.session!.permissions.has('run.create.org')
          ? null
          : await getActorStoreIds(tx, ctx.session!.memberId, ctx.session!.permissions);
        if (allowedStoreIds !== null && allowedStoreIds.length === 0) return [];

        const runs = await tx
          .select()
          .from(s.marketRunsV)
          .where(
            and(
              eq(s.marketRunsV.orgId, ctx.session!.orgId),
              eq(s.marketRunsV.status, 'finished'),
            ),
          )
          .orderBy(desc(s.marketRunsV.runDate), desc(s.marketRunsV.runIndex))
          .limit(input?.limit ?? 100);

        if (runs.length === 0) return [];

        let visibleRuns = runs;
        const allowedStoreSet = allowedStoreIds === null ? null : new Set(allowedStoreIds);
        const allSessionIds = [
          ...new Set(runs.flatMap((run) => (run.sessionIdsJson as string[] | null) ?? [])),
        ];
        if (allowedStoreSet) {
          if (allSessionIds.length === 0) return [];
          const sessionRows = await tx.query.orderSessionsV.findMany({
            where: (session, { inArray }) => inArray(session.id, allSessionIds),
            columns: { id: true, storeId: true },
          });
          const storeBySession = new Map(sessionRows.map((session) => [session.id, session.storeId]));
          visibleRuns = runs.filter((run) =>
            ((run.sessionIdsJson as string[] | null) ?? []).some((sessionId) =>
              allowedStoreSet.has(storeBySession.get(sessionId) ?? ''),
            ),
          );
        }
        if (visibleRuns.length === 0) return [];

        type MutableStoreTotal = {
          storeId: string;
          total: number;
          cash: number;
          transfer: number;
          skuIds: Set<string>;
        };
        const totalsByRun = new Map<string, Map<string, MutableStoreTotal>>();
        const ensureStoreTotal = (runId: string, storeId: string): MutableStoreTotal | null => {
          if (allowedStoreSet && !allowedStoreSet.has(storeId)) return null;
          let runTotals = totalsByRun.get(runId);
          if (!runTotals) {
            runTotals = new Map<string, MutableStoreTotal>();
            totalsByRun.set(runId, runTotals);
          }
          let current = runTotals.get(storeId);
          if (!current) {
            current = { storeId, total: 0, cash: 0, transfer: 0, skuIds: new Set<string>() };
            runTotals.set(storeId, current);
          }
          return current;
        };
        const visibleRunIds = visibleRuns.map((run) => run.id);
        const splitRows = await tx
          .select({
            runId: s.runItemStoresV.runId,
            storeId: s.runItemStoresV.storeId,
            skuId: s.runItemStoresV.skuId,
            qty: s.runItemStoresV.qty,
            itemUnitPrice: s.runItemsV.unitPrice,
            itemPaymentMethod: s.runItemsV.paymentMethod,
            splitUnitPrice: s.runItemStoresV.unitPrice,
            splitPaymentMethod: s.runItemStoresV.paymentMethod,
          })
          .from(s.runItemStoresV)
          .innerJoin(
            s.runItemsV,
            and(
              eq(s.runItemsV.runId, s.runItemStoresV.runId),
              eq(s.runItemsV.skuId, s.runItemStoresV.skuId),
            ),
          )
          .where(
            and(
              inArray(s.runItemStoresV.runId, visibleRunIds),
              eq(s.runItemsV.status, 'purchased'),
            ),
          );
        for (const row of splitRows) {
          const unitPrice = row.splitUnitPrice ?? row.itemUnitPrice;
          if (!unitPrice) continue;
          const subtotal = Number(row.qty) * Number(unitPrice);
          if (!Number.isFinite(subtotal)) continue;
          const current = ensureStoreTotal(row.runId, row.storeId);
          if (!current) continue;
          current.total += subtotal;
          if ((row.splitPaymentMethod ?? row.itemPaymentMethod) === 'transfer') {
            current.transfer += subtotal;
          } else {
            current.cash += subtotal;
          }
          current.skuIds.add(row.skuId);
        }
        const moneyString = (n: number) => (Math.round(n * 100) / 100).toString();
        return visibleRuns.map((run) => ({
          ...run,
          storeTotals: [...(totalsByRun.get(run.id)?.values() ?? [])]
            .sort((a, b) => b.total - a.total)
            .map((total) => ({
              storeId: total.storeId,
              total: moneyString(total.total),
              cash: moneyString(total.cash),
              transfer: moneyString(total.transfer),
              itemCount: total.skuIds.size,
            })),
        }));
      }),
    ),

  get: authedProcedure
    .input(SimpleRunCommandSchema.pick({ runId: true }))
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const run = await loadRun(tx, ctx.session!.orgId, input.runId);

        // M3.33 (2026-05-18, Wave1 #2): store-scope check. Org-tier
        // bypasses; store-tier actors can only read runs whose sessions
        // touch at least one store they're bound to. Without this,
        // anyone with a runId could read its full demand + extras
        // (cross-store information leak — paired with the same fix
        // on run.list).
        if (!ctx.session!.permissions.has('run.create.org')) {
          const allowedStoreIds = await getActorStoreIds(
            tx,
            ctx.session!.memberId,
            ctx.session!.permissions,
          );
          if (allowedStoreIds !== null) {
            const involvedStoreIds = await runInvolvedStoreIds(tx, run);
            const allowed = new Set(allowedStoreIds);
            const overlap = involvedStoreIds.some((sid) => allowed.has(sid));
            if (!overlap) {
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: 'run.errors.notVisible',
              });
            }
          }
        }

        // 2026-07-26: both queries were unordered. Postgres returns heap
        // order, and every UPDATE (i.e. every recorded purchase) writes a
        // new tuple at the heap tail — so a row the purchaser just saved
        // jumped to the bottom of the list. Combined with the RunPage's
        // 6s poll, the whole list could reshuffle under the user's thumb
        // mid-market. Ordering by the read model's PK columns is stable,
        // free (both are index scans on (run_id, sku_id[, store_id])),
        // and gives the client a deterministic base to re-sort on top of.
        const items = await tx.query.runItemsV.findMany({
          where: (i, { eq: eq2 }) => eq2(i.runId, run.id),
          orderBy: (i, { asc }) => asc(i.skuId),
        });
        const splits = await tx.query.runItemStoresV.findMany({
          where: (i, { eq: eq2 }) => eq2(i.runId, run.id),
          orderBy: (i, { asc }) => [asc(i.skuId), asc(i.storeId)],
        });

        // Per-(store, sku) demand from the underlying sessions. The
        // RunPage uses this to PRE-FILL splits when the purchaser
        // records a buy inline — without it, the client would have to
        // dump the entire planned qty into one store and the user would
        // re-allocate every time. With it, "bought as planned" is one
        // tap (just enter price). The aggregation lives here in the
        // API rather than client-side because:
        //   - it's pure SQL and trivially cheap (≤ tens of rows)
        //   - centralizing the math means cancel-cascade and
        //     re-planning paths can't drift from the client's defaults.
        const sessionIds = (run.sessionIdsJson ?? []) as string[];
        let perStoreDemand: Array<{ storeId: string; skuId: string; qty: string }> = [];
        // M1.8 (2026-05-07): per-store concatenated session notes so the
        // purchaser sees the staff's "其他物品" requests next to that
        // store's demand block. M3.16-C extends this with per-store
        // structured extras (name + qty + unit + note?) emitted as the
        // M3.16+ replacement for free-text notes.
        // M3.37 (2026-05-19, Wave2 #5): each extra carries sessionId +
        // idx + status so the FE can route taps into the
        // `order.markExtraStatus` mutation. Same enrichment as the
        // run.previewCreatable path above — kept in sync manually.
        type ExtraItem = {
          name: string;
          qty: string;
          unit: string;
          note?: string;
          status?: 'pending' | 'bought' | 'unavailable';
          sessionId: string;
          idx: number;
        };
        const sessionNotesByStore: Record<string, string> = {};
        const sessionExtrasByStore: Record<string, ExtraItem[]> = {};
        let runSessions: Array<{
          id: string;
          storeId: string;
          submittedByMemberId: string | null;
          initiatedByMemberId: string | null;
          submittedByDisplayName: string | null;
          itemCount: number;
          totalQty: string;
          extrasCount: number;
          status: string;
        }> = [];
        if (sessionIds.length > 0) {
          const sessions = await tx.query.orderSessionsV.findMany({
            where: (sess, { inArray: ia }) => ia(sess.id, sessionIds),
            columns: {
              id: true,
              storeId: true,
              notes: true,
              extrasJson: true,
              submittedByMemberId: true,
              initiatedByMemberId: true,
              status: true,
            },
          });
          const sessionItems = await tx.query.orderItemsV.findMany({
            where: (it, { inArray: ia }) => ia(it.sessionId, sessionIds),
          });
          const sessionStoreById = new Map<string, string>();
          const sessionStats = new Map<string, { itemCount: number; totalQty: number }>();
          const noteAccumulator = new Map<string, string[]>();
          const extrasAccumulator = new Map<string, ExtraItem[]>();
          for (const s of sessions) {
            sessionStoreById.set(s.id, s.storeId);
            const trimmed = (s.notes ?? '').trim();
            if (trimmed) {
              const arr = noteAccumulator.get(s.storeId) ?? [];
              arr.push(trimmed);
              noteAccumulator.set(s.storeId, arr);
            }
            const sessionExtras = (s.extrasJson ?? []) as Array<{
              name: string;
              qty: string;
              unit: string;
              note?: string;
              status?: 'pending' | 'bought' | 'unavailable';
            }>;
            if (sessionExtras.length > 0) {
              const arr = extrasAccumulator.get(s.storeId) ?? [];
              for (let i = 0; i < sessionExtras.length; i++) {
                const ex = sessionExtras[i]!;
                arr.push({ ...ex, sessionId: s.id, idx: i });
              }
              extrasAccumulator.set(s.storeId, arr);
            }
          }
          for (const it of sessionItems) {
            const qty = Number(it.qty);
            if (qty <= 0) continue;
            const stat = sessionStats.get(it.sessionId) ?? { itemCount: 0, totalQty: 0 };
            stat.itemCount += 1;
            stat.totalQty += qty;
            sessionStats.set(it.sessionId, stat);
          }
          const submitterIds = [
            ...new Set(
              sessions
                .map((sess) => sess.submittedByMemberId ?? sess.initiatedByMemberId)
                .filter((id): id is string => Boolean(id)),
            ),
          ];
          const displayNameByMemberId = new Map<string, string>();
          if (submitterIds.length > 0) {
            const rows = await tx
              .select({
                memberId: s.members.id,
                displayName: s.users.displayName,
              })
              .from(s.members)
              .innerJoin(s.users, eq(s.users.id, s.members.userId))
              .where(inArray(s.members.id, submitterIds));
            for (const row of rows) displayNameByMemberId.set(row.memberId, row.displayName);
          }
          runSessions = sessions.map((sess) => {
            const stat = sessionStats.get(sess.id) ?? { itemCount: 0, totalQty: 0 };
            const submitterId = sess.submittedByMemberId ?? sess.initiatedByMemberId;
            const extras = (sess.extrasJson ?? []) as unknown[];
            return {
              id: sess.id,
              storeId: sess.storeId,
              submittedByMemberId: sess.submittedByMemberId,
              initiatedByMemberId: sess.initiatedByMemberId,
              submittedByDisplayName: submitterId
                ? displayNameByMemberId.get(submitterId) ?? null
                : null,
              itemCount: stat.itemCount,
              totalQty: stat.totalQty.toString(),
              extrasCount: Array.isArray(extras) ? extras.length : 0,
              status: sess.status,
            };
          });
          for (const [sid, arr] of noteAccumulator.entries()) {
            sessionNotesByStore[sid] = arr.join('\n\n');
          }
          for (const [sid, arr] of extrasAccumulator.entries()) {
            sessionExtrasByStore[sid] = arr;
          }
          // Aggregate qty by (storeId, skuId).
          const acc = new Map<string, number>();
          for (const it of sessionItems) {
            const storeId = sessionStoreById.get(it.sessionId);
            if (!storeId) continue;
            const qty = Number(it.qty);
            if (qty <= 0) continue;
            const key = `${storeId}|${it.skuId}`;
            acc.set(key, (acc.get(key) ?? 0) + qty);
          }
          for (const [key, qty] of acc) {
            const [storeId, skuId] = key.split('|');
            perStoreDemand.push({
              storeId: storeId!,
              skuId: skuId!,
              qty: qty.toString(),
            });
          }
        }

        // M3.27 (2026-05-18): preferred-supplier mapping for the
        // active-run "by vendor" view. Mirrors previewCreatable's
        // logic verbatim (preview/active should always agree on which
        // stall an item is routed to). Only one DISTINCT ON query
        // for all SKUs in the run.
        const runSkuIds = items.map((it) => it.skuId);
        const supplierBySku: Record<string, {
          id: string;
          name: string;
          contactPhone: string | null;
          contactTg: string | null;
        } | null> = {};
        if (runSkuIds.length > 0) {
          const rows = await tx.execute<{
            sku_id: string;
            supplier_id: string;
            name: string;
            contact_phone: string | null;
            contact_tg: string | null;
          }>(sql`
            SELECT DISTINCT ON (sl.sku_id)
              sl.sku_id, sl.supplier_id,
              sup.name, sup.contact_phone, sup.contact_tg
            FROM inventory.sku_supplier_links sl
            INNER JOIN inventory.suppliers sup ON sup.id = sl.supplier_id
            WHERE sl.sku_id IN ${runSkuIds}
              AND sup.is_archived = false
              AND sl.is_preferred = true
            ORDER BY sl.sku_id,
                     sl.last_seen_at DESC NULLS LAST
          `);
          const list = Array.isArray(rows)
            ? rows
            : ((rows as { rows?: typeof rows }).rows ?? []);
          for (const r of list) {
            supplierBySku[r.sku_id] = {
              id: r.supplier_id,
              name: r.name,
              contactPhone: r.contact_phone,
              contactTg: r.contact_tg,
            };
          }
          for (const sid of runSkuIds) {
            if (!(sid in supplierBySku)) supplierBySku[sid] = null;
          }
        }

        // Most-recent observed unit_price per SKU, across all past runs.
        // Pre-fills the inline price input when the user records a buy
        // — saves the typing if the market price hasn't changed since
        // the last run. The user explicitly asked for this:
        // "如果今天市场上价格还是一样就不用再受定改了".
        //
        // We use Postgres `DISTINCT ON` for an efficient one-row-per-sku
        // pull (single index scan) instead of N round-trips.
        const skuIds = items.map((it) => it.skuId);
        const lastPriceBySku: Record<string, string> = {};
        // 2026-07-26: WHEN the reference price was observed, alongside
        // what it was. The purchase row carries a price forward from the
        // last trip; a price from three weeks ago deserves a different
        // amount of trust than one from yesterday, and the finish sheet
        // needs to say how many carried-over prices were stale. Kept as
        // a PARALLEL map rather than changing lastPriceBySku's shape:
        // that field feeds the inline price prefill in three mount
        // sites, and reshaping the money path to add a timestamp is a
        // bad trade.
        const lastPriceObservedAtBySku: Record<string, string> = {};
        if (skuIds.length > 0) {
          const rows = (await tx.execute(
            sql`SELECT DISTINCT ON (sku_id) sku_id::text AS sku_id,
                       unit_price::text AS unit_price,
                       observed_at
                FROM inventory.price_history
                WHERE org_id = ${ctx.session!.orgId}
                  AND sku_id IN (${sql.raw(
                    skuIds.map((id) => `'${id}'`).join(','),
                  )})
                ORDER BY sku_id, observed_at DESC`,
          )) as unknown as Array<{
            sku_id: string;
            unit_price: string;
            observed_at: Date | string;
          }>;
          for (const r of rows) {
            lastPriceBySku[r.sku_id] = r.unit_price;
            lastPriceObservedAtBySku[r.sku_id] =
              r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at);
          }
        }
        // C.2 (M3.38, 2026-05-19): resolve display names for the
        // claim banner. Same shape as the order side's
        // claimedByDisplayName / previousClaimerDisplayName. Loaded in
        // one IN query so single-actor runs don't double-query the
        // members table.
        const claimerIds = new Set<string>();
        if (run.claimedByMemberId) claimerIds.add(run.claimedByMemberId);
        if (run.previousClaimerMemberId) claimerIds.add(run.previousClaimerMemberId);
        let claimedByDisplayName: string | null = null;
        let previousClaimerDisplayName: string | null = null;
        if (claimerIds.size > 0) {
          const rows = await tx
            .select({
              memberId: s.members.id,
              displayName: s.users.displayName,
            })
            .from(s.members)
            .innerJoin(s.users, eq(s.users.id, s.members.userId))
            .where(inArray(s.members.id, [...claimerIds]));
          const byId = new Map(rows.map((r) => [r.memberId, r.displayName]));
          if (run.claimedByMemberId) {
            claimedByDisplayName = byId.get(run.claimedByMemberId) ?? null;
          }
          if (run.previousClaimerMemberId) {
            previousClaimerDisplayName = byId.get(run.previousClaimerMemberId) ?? null;
          }
        }
        // M3.44 (2026-05-22): active expenses for this run. Only the
        // non-removed ones make it into the FE payload — the
        // `removed_at IS NULL` filter is partial-indexed
        // (rev_active_idx) so this is a cheap lookup. Admin reports
        // pull the full table (including removed rows) via a separate
        // query.
        const expenses = await tx.query.runExpensesV.findMany({
          where: (e, { eq: eq2, and: and2, isNull }) =>
            and2(eq2(e.runId, run.id), isNull(e.removedAt)),
          orderBy: (e, { asc }) => asc(e.addedAt),
        });

        return {
          ...run,
          items,
          splits,
          perStoreDemand,
          lastPriceBySku,
          lastPriceObservedAtBySku,
          sessionNotesByStore,
          sessionExtrasByStore,
          supplierBySku,
          sessions: runSessions,
          // M3.44: off-catalog expenses (purchaser-recorded). FE
          // renders these in an "Off-catalog / Expenses" card and
          // sums them into the finish-summary breakdown.
          expenses: expenses.map((e) => ({
            id: e.id,
            label: e.label,
            unitHint: e.unitHint,
            qty: e.qty,
            unitPrice: e.unitPrice,
            storeSplits: e.storeSplitsJson as Array<{
              storeId: string;
              qty: string;
            }>,
            paymentMethod: e.paymentMethod,
            receiptPhotoUrl: e.receiptPhotoUrl,
            reason: e.reason,
            addedByMemberId: e.addedByMemberId,
            addedAt: e.addedAt.toISOString(),
          })),
          // C.2: claim display fields. The raw memberId columns are
          // already in `...run` (drizzle spreads the row); these are
          // the resolved names for the banner.
          claimedByDisplayName,
          previousClaimerDisplayName,
          claimedAt: run.claimedAt?.toISOString() ?? null,
        };
      });
    }),

  /**
   * C.2 (M3.38, 2026-05-19): claim a run so other purchasers can't
   * mutate it concurrently. Mirrors `order.claim`. The FE calls this
   * on RunPage mount when status ∈ {purchasing, delivering}. The
   * domain layer's `assertClaimOwnership` is what actually enforces
   * the lock; this endpoint just announces "I'm taking it".
   */
  claim: authedProcedure
    .input(SimpleRunCommandSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, { type: 'ClaimRun', actor: actorFromCtx(ctx) }),
      ),
    ),

  /**
   * C.2 (M3.38, 2026-05-19): release a run claim. Reason 'manual' for
   * the explicit Release button; 'pagehide' for the FE's
   * visibilitychange auto-release. Override path: when the caller is
   * NOT the current claimer, the domain layer re-tags the emitted
   * event with reason 'override' (the take-over button uses this).
   */
  releaseClaim: authedProcedure
    .input(
      SimpleRunCommandSchema.extend({
        reason: z.enum(['manual', 'pagehide']).default('manual'),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'ReleaseRunClaim',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  startPurchase: authedProcedure.input(SimpleRunCommandSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.runId, (state) =>
      decideRun(state, { type: 'StartPurchase', actor: actorFromCtx(ctx) }),
    ),
  ),

  // M1.20: idempotent — record-purchase replays would double-deduct
  // inventory + double-record price history.
  purchaseItem: idempotentMutation.input(PurchaseItemInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.runId, (state) =>
      decideRun(state, {
        type: 'PurchaseItem',
        skuId: input.skuId,
        supplierId: input.supplierId,
        unitPrice: input.unitPrice,
        actualQty: input.actualQty,
        receiptPhotoUrl: input.receiptPhotoUrl,
        storeSplits: input.storeSplits,
        paymentMethod: input.paymentMethod,
        actor: actorFromCtx(ctx),
      }),
    ),
  ),

  /**
   * M3.41 (2026-05-21): purchaser-initiated mid-run addition. Records
   * a purchase for a SKU that wasn't in the original aggregated demand
   * — used for impromptu bazaar buys, chef-call-in top-ups, etc.
   * The domain layer enforces that the SKU isn't already in the run
   * (use RevisePurchase to grow an existing row), that every storeId
   * in the splits is already part of the run's store scope (use
   * AttachSessions to bring in a new store), and that `reason` is
   * non-empty so audit can answer "why was this added?". The
   * resulting row carries `addedByPurchaser=true` so finish summary
   * + reports surface it separately from the planned ask.
   *
   * Idempotent: replays of the same X-Idempotency-Key short-circuit
   * back to the prior result.
   */
  addPurchaserItem: idempotentMutation
    .input(AddPurchaserItemInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'AddPurchaserItem',
          skuId: input.skuId,
          supplierId: input.supplierId,
          unitPrice: input.unitPrice,
          actualQty: input.actualQty,
          receiptPhotoUrl: input.receiptPhotoUrl,
          storeSplits: input.storeSplits,
          paymentMethod: input.paymentMethod,
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  /**
   * M3.44 (2026-05-22): off-catalog expense — free-text item OR shared
   * cost (porter, taxi, parking). `expenseId` is CLIENT-generated so
   * the FE owns the id before save (no roundtrip to learn it) AND
   * replays of the same X-Idempotency-Key short-circuit cleanly.
   *
   * The domain layer enforces:
   *   - claim ownership (C.2)
   *   - actor has `run.purchase`
   *   - status NOT in {finished, cancelled}
   *   - all storeSplits within run scope
   *   - receipt photo when total > 200,000 UZS
   */
  addExpense: idempotentMutation
    .input(AddRunExpenseInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'AddRunExpense',
          expenseId: input.expenseId,
          label: input.label,
          ...(input.unitHint !== undefined ? { unitHint: input.unitHint } : {}),
          qty: input.qty,
          unitPrice: input.unitPrice,
          storeSplits: input.storeSplits,
          paymentMethod: input.paymentMethod,
          receiptPhotoUrl: input.receiptPhotoUrl,
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  /**
   * M3.44: soft-delete an expense before the run is finished. The
   * RunExpenseAdded event stays in the log; the read-model row gets
   * removed_at/removed_by_member_id/remove_reason filled in so admin
   * reports can show the full add → remove story.
   */
  removeExpense: authedProcedure
    .input(RemoveRunExpenseInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'RemoveRunExpense',
          expenseId: input.expenseId,
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  markUnavailable: authedProcedure
    .input(MarkUnavailableInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'MarkUnavailable',
          skuId: input.skuId,
          note: input.note,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  startDelivery: authedProcedure.input(SimpleRunCommandSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.runId, (state) =>
      decideRun(state, { type: 'StartDelivery', actor: actorFromCtx(ctx) }),
    ),
  ),

  deliverToStore: authedProcedure.input(DispatchInputSchema).mutation(async ({ ctx, input }) => {
    // Purchaser delivering — they need run.purchase, NOT a store-scope
    // assignment. (The purchaser drives the run on behalf of all stores.)
    //
    // Per-store override (added 2026-05-06): even though the purchaser
    // doesn't need MSA, an admin may still have written a store-scoped
    // deny override on `delivery.dispatch` to lock this purchaser out
    // of one specific store's deliveries. Compute effective perms for
    // input.storeId and pass them into actorFromCtx.
    const effectivePerms = await ctx.withOrg((tx) =>
      effectivePermissionsForStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      ),
    );
    return runSimpleCommand(ctx, input.runId, (state) =>
      decideRun(state, {
        type: 'DeliverToStore',
        storeId: input.storeId,
        actor: actorFromCtx(ctx, effectivePerms),
      }),
    );
  }),

  confirmStoreItem: authedProcedure
    .input(ConfirmStoreItemInputSchema)
    .mutation(async ({ ctx, input }) => {
      // Receiver-side confirm: only members assigned to this store may
      // accept its incoming delivery. Same pass also computes the
      // store-effective permissions (added 2026-05-06) so allow/deny
      // overrides scoped to this store flow into the domain check.
      const effectivePerms = await ctx.withOrg(async (tx) => {
        await assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        );
        return effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        );
      });
      return runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'ConfirmStoreItem',
          storeId: input.storeId,
          skuId: input.skuId,
          status: input.status,
          note: input.note,
          photoUrl: input.photoUrl,
          actor: actorFromCtx(ctx, effectivePerms),
        }),
      );
    }),

  confirmStore: authedProcedure.input(ConfirmStoreInputSchema).mutation(async ({ ctx, input }) => {
    const effectivePerms = await ctx.withOrg(async (tx) => {
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      );
      return effectivePermissionsForStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      );
    });
    return runSimpleCommand(ctx, input.runId, (state) =>
      decideRun(state, {
        type: 'ConfirmStore',
        storeId: input.storeId,
        actor: actorFromCtx(ctx, effectivePerms),
      }),
    );
  }),

  /**
   * Finish the run. Cascading effect (added 2026-05-03):
   *
   *   1. RunFinished on the run stream (status → finished)
   *   2. Archived on each attached session stream (status → archived)
   *
   * Without step 2 the sessions stay at `in_run` forever, even though
   * the goods have been delivered and confirmed. The order page would
   * keep showing "submitted · in run" with no way to reach a clean
   * "done" state, and the same SKU couldn't appear in a future run
   * (would conflict on the in_run guard).
   *
   * After the cascade, the run + its sessions are visible in the
   * RunPage history view but no longer occupy the active spots on
   * Order / Approval / Run pages.
   *
   * M3.4 (2026-05-15) — ATOMICITY:
   *   The original implementation logged + continued on a session's
   *   Archive failure, leaving Step 1's RunFinished event committed
   *   while one or more sessions remained `in_run`. Result: the run
   *   showed "finished" but the session stayed pinned and couldn't
   *   be re-used in a future run — silently wedged forever.
   *
   *   Now the entire cascade runs inside `ctx.withOrg` (one tx).
   *   We collect every session's failure into `archiveFailures`;
   *   if the list is non-empty after the loop we throw, which rolls
   *   back BOTH the RunFinished event AND any partial session
   *   archives. The operator gets a structured error with the full
   *   failure list and retries after fixing the cause.
   *
   *   Re-running `finish` on a partially-archived state is safe
   *   thanks to the `if (oState.status === 'archived') continue`
   *   skip at line ~906 — already-archived sessions become no-ops.
   *   Combined with idempotentMutation, the whole flow tolerates
   *   network retries without producing duplicate events.
   */
  // M1.20: idempotent — finish locks the run + writes totals; a
  // retry must NOT compute a second total.
  finish: idempotentMutation.input(SimpleRunCommandSchema).mutation(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const run = await loadRun(tx, ctx.session!.orgId, input.runId);
      await assertRunStoreVisible(tx, ctx, run);
      const runEvents = (await readStream(tx, 'run', run.id)) as unknown as RunEvent[];
      let runState = emptyRunState(run.id);
      for (const e of runEvents) runState = applyRun(runState, e);

      // Step 1 — RunFinished on the run stream.
      let finishEvents: RunEvent[] = [];
      try {
        finishEvents = decideRun(runState, {
          type: 'FinishRun',
          actor: actorFromCtx(ctx),
        });
      } catch (err) {
        if (err instanceof DomainError) rethrowDomainError(err);
        throw err;
      }
      if (finishEvents.length > 0) {
        await appendEvents(tx, {
          streamType: 'run',
          streamId: run.id,
          orgId: ctx.session!.orgId,
          events: finishEvents.map((e) => ({ ...e })),
        });
        for (const e of finishEvents) runState = applyRun(runState, e);
        await projectRun(tx, ctx.session!.orgId, finishEvents);
        await dispatchRunEventNotifications(
          tx,
          ctx.session!.orgId,
          ctx.session!.userId,
          runState,
          finishEvents,
        );
      }

      // Step 2 — Archive every attached session.
      //
      // M3.4: collect failures, do NOT continue silently. If any
      // session can't be archived, the whole tx (including the
      // RunFinished event committed in Step 1) rolls back so we
      // never end up with run.status='finished' AND session.status
      // ='in_run' on the same data.
      const archiveFailures: Array<{ sessionId: string; reason: string }> = [];
      for (const sessionId of runState.sessionIds) {
        const orderEvents = (await readStream(tx, 'order', sessionId)) as unknown as OrderEvent[];
        let oState = emptyOrderState(sessionId);
        for (const e of orderEvents) oState = applyOrder(oState, e);
        if (oState.status === 'archived') continue; // already archived → no-op

        let ev: OrderEvent[] = [];
        try {
          ev = decideOrder(oState, {
            type: 'Archive',
            reason: 'run_finished',
            actor: {
              userId: ctx.session!.userId,
              memberId: ctx.session!.memberId,
              permissions: ctx.session!.permissions,
              isClaimer: oState.claimedByMemberId === ctx.session!.memberId,
            },
          });
        } catch (err) {
          if (err instanceof DomainError) {
            archiveFailures.push({ sessionId, reason: err.message });
            ctx.log.warn(
              { sessionId, runId: run.id, err: err.message },
              'finish: failed to archive session — will roll back the run-finish',
            );
            continue;
          }
          throw err;
        }
        if (ev.length > 0) {
          try {
            await appendEvents(tx, {
              streamType: 'order',
              streamId: sessionId,
              orgId: ctx.session!.orgId,
              events: ev.map((e) => ({ ...e })),
            });
            await projectOrder(tx, ctx.session!.orgId, ev);
          } catch (err) {
            // M3.4: append/project failures count too. A seq
            // collision or projection error here would leave the
            // session partially advanced; record + roll back.
            archiveFailures.push({
              sessionId,
              reason: err instanceof Error ? err.message : String(err),
            });
            ctx.log.warn(
              { sessionId, runId: run.id, err: archiveFailures.at(-1)!.reason },
              'finish: append/project failed for session archive — will roll back the run-finish',
            );
            continue;
          }
        }
      }

      // M3.4 atomicity bar — if any session failed, abort the whole
      // tx by throwing. ctx.withOrg's transaction roll-back undoes the
      // Step-1 RunFinished event AND any partial archives we may have
      // committed in this loop iteration before the failure.
      if (archiveFailures.length > 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'run.errors.archiveCascadeFailed',
          cause: {
            runId: run.id,
            archiveFailures,
          },
        });
      }

      // Realtime nudge so connected order/approve clients refresh.
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: run.id,
        lastSeq: runState.seq,
      });
      for (const sessionId of runState.sessionIds) {
        hub.publish(ctx.session!.orgId, {
          type: 'order.changed',
          orgId: ctx.session!.orgId,
          sessionId,
          lastSeq: -1,
        });
      }

      // archiveFailures is always empty on success (any non-empty
       // list would have thrown above). Kept in the response shape
       // for FE backwards compat — older clients may still read it.
      return { lastSeq: runState.seq, archiveFailures: [] as Array<{ sessionId: string; reason: string }> };
    });
  }),

  // ---- Reversal endpoints (added 2026-05-03) ----------------------------
  // Every "I changed my mind" path the UI needs. Each takes a non-empty
  // reason — domain-side guard rejects whitespace-only.

  /** Edit an already-purchased item (qty/price/supplier/photo/splits). */
  // M1.20: idempotent — revise rewrites unit price + splits; replay
  // could fork the price_history table.
  revisePurchase: idempotentMutation
    .input(RevisePurchaseInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'RevisePurchase',
          skuId: input.skuId,
          supplierId: input.supplierId,
          unitPrice: input.unitPrice,
          actualQty: input.actualQty,
          receiptPhotoUrl: input.receiptPhotoUrl,
          storeSplits: input.storeSplits,
          reason: input.reason,
          paymentMethod: input.paymentMethod,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  /** Flip an unavailable item back to pending (e.g. found another supplier). */
  unmarkUnavailable: authedProcedure
    .input(UnmarkUnavailableInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'UnmarkUnavailable',
          skuId: input.skuId,
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  /** Revert a purchased item back to pending (mistapped row, decided
   *  not to buy after all). Blocked once any destination store has
   *  accepted delivery. */
  undoPurchase: authedProcedure
    .input(UndoPurchaseInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'UndoPurchase',
          skuId: input.skuId,
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  /**
   * 2026-07-06: super-admin (run.amend) reopens a FINISHED run to correct
   * it. Moves finished → amending, which unlocks the normal edit
   * procedures (revisePurchase / addPurchaserItem / undoPurchase /
   * add|removeExpense) for run.amend holders. Close with `refinalize`,
   * which recomputes + re-freezes the totals. The domain enforces the
   * permission + finished-only guard.
   */
  reopen: authedProcedure
    .input(RunReasonOnlyInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'ReopenRun',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  /** Close a super-admin correction: recompute + re-freeze the run
   *  totals and return amending → finished. */
  refinalize: authedProcedure
    .input(SimpleRunCommandSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, { type: 'RefinalizeRun', actor: actorFromCtx(ctx) }),
      ),
    ),

  /** Recall a delivery to a store that has not yet confirmed receipt. */
  undeliverStore: authedProcedure
    .input(UndeliverStoreInputSchema)
    .mutation(async ({ ctx, input }) => {
      const effectivePerms = await ctx.withOrg((tx) =>
        effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        ),
      );
      return runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'UndeliverStore',
          storeId: input.storeId,
          reason: input.reason,
          actor: actorFromCtx(ctx, effectivePerms),
        }),
      );
    }),

  /** Roll the run back to `planned` (only if no item touched yet). */
  undoStartPurchase: authedProcedure
    .input(RunReasonOnlyInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'UndoStartPurchase',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  /** Roll the run back to `purchasing` (only if no store delivered yet). */
  undoStartDelivery: authedProcedure
    .input(RunReasonOnlyInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'UndoStartDelivery',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  /**
   * Cancel the entire run. Cascading effect:
   *
   *   1. RunCancelled on the run stream (status → cancelled)
   *   2. EjectedFromRun on EVERY attached session stream (status → approved,
   *      runId → null) so those sessions become available for the next
   *      run instead of being stuck at `in_run` forever.
   *
   * Without step 2 (the bug the user hit on 2026-05-03): cancelling a run
   * left the user's order page showing "Submitted · in run" with no way to
   * progress, the approval page filtered out non-submitted statuses, and
   * the run page filtered out cancelled runs — so the order disappeared
   * from every screen and could never be re-planned.
   *
   * Items already marked Purchased / Unavailable on the run stream remain
   * in the audit log (event sourcing is append-only). Goods physically
   * delivered before cancel stay where they are; cancelling does not undo
   * physical reality. The receiving stores can flag any issues via the
   * normal confirm/issue flow against the next run.
   */
  // 2026-07-26: was RunReasonOnlyInputSchema (`reason: min(1)`), which
  // rejected the empty reason the FE deliberately sends — every
  // no-reason cancel died as BAD_REQUEST behind a generic error toast.
  // The domain has allowed an empty reason since M1.7; only the edge
  // schema disagreed. See RunCancelInputSchema for why the shared
  // schema was NOT relaxed instead.
  cancel: authedProcedure.input(RunCancelInputSchema).mutation(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const run = await loadRun(tx, ctx.session!.orgId, input.runId);
      await assertRunStoreVisible(tx, ctx, run);
      const runEvents = (await readStream(tx, 'run', run.id)) as unknown as RunEvent[];
      let runState = emptyRunState(run.id);
      for (const e of runEvents) runState = applyRun(runState, e);

      // Step 1 — produce RunCancelled. Domain validates permission +
      // status guards (e.g. not already finished).
      let cancelEvents: RunEvent[] = [];
      try {
        cancelEvents = decideRun(runState, {
          type: 'CancelRun',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        });
      } catch (err) {
        if (err instanceof DomainError) rethrowDomainError(err);
        throw err;
      }
      if (cancelEvents.length > 0) {
        await appendEvents(tx, {
          streamType: 'run',
          streamId: run.id,
          orgId: ctx.session!.orgId,
          events: cancelEvents.map((e) => ({ ...e })),
        });
        for (const e of cancelEvents) runState = applyRun(runState, e);
        await projectRun(tx, ctx.session!.orgId, cancelEvents);
      }

      // Step 2 — eject every attached session. Sessions that are still
      // `in_run` get `EjectedFromRun` (status → approved). Sessions that
      // somehow drifted out of `in_run` already (defensive) just no-op.
      const sessionIds = runState.sessionIds;
      const ejectionFailures: Array<{ sessionId: string; reason: string }> = [];
      for (const sessionId of sessionIds) {
        const orderEvents = (await readStream(tx, 'order', sessionId)) as unknown as OrderEvent[];
        let oState = emptyOrderState(sessionId);
        for (const e of orderEvents) oState = applyOrder(oState, e);

        // Only eject if still attached to THIS run. If the session was
        // already manually ejected earlier, skip silently.
        if (oState.status !== 'in_run' || oState.runId !== run.id) continue;

        // M1.7-fix (2026-05-07, audit CRITICAL #2): eject the session
        // with a synthesized `run.eject_session` permission. The cancel-
        // run authorization (run.create) already proved the actor has
        // the right to dismantle this run — if they didn't have
        // run.eject_session in their original permission set, the
        // per-session EjectFromRun would silently fail and leave the
        // run "cancelled" with N orphaned in_run sessions. Granting
        // the perm at this synthesis layer is safe because we're
        // already inside an authorized cancel; we're not letting the
        // actor eject sessions outside of this cancellation.
        const ejectPerms = new Set([
          ...ctx.session!.permissions,
          'run.eject_session',
        ]);
        let ev: OrderEvent[] = [];
        try {
          ev = decideOrder(oState, {
            type: 'EjectFromRun',
            runId: run.id,
            reason: input.reason,
            actor: {
              userId: ctx.session!.userId,
              memberId: ctx.session!.memberId,
              permissions: ejectPerms,
              isClaimer: oState.claimedByMemberId === ctx.session!.memberId,
            },
          });
        } catch (err) {
          // Don't let a single session's failure abort the entire cancel
          // (which would leave the run in a half-cancelled state). Log
          // and continue; the operator can manually re-eject if needed.
          if (err instanceof DomainError) {
            ejectionFailures.push({ sessionId, reason: err.message });
            ctx.log.warn(
              { sessionId, runId: run.id, err: err.message },
              'cancel: failed to eject session — left in_run',
            );
            continue;
          }
          throw err;
        }
        if (ev.length > 0) {
          await appendEvents(tx, {
            streamType: 'order',
            streamId: sessionId,
            orgId: ctx.session!.orgId,
            events: ev.map((e) => ({ ...e })),
          });
          await projectOrder(tx, ctx.session!.orgId, ev);
        }
      }

      // Realtime ping so connected clients refresh both pages.
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: run.id,
        lastSeq: runState.seq,
      });
      for (const sessionId of sessionIds) {
        hub.publish(ctx.session!.orgId, {
          type: 'order.changed',
          orgId: ctx.session!.orgId,
          sessionId,
          lastSeq: -1, // we don't track per-session seq here — clients refetch
        });
      }

      return {
        lastSeq: runState.seq,
        ejectedSessions: sessionIds.length - ejectionFailures.length,
        ejectionFailures,
      };
    });
  }),

  ejectSession: authedProcedure.input(EjectSessionInputSchema).mutation(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const run = await loadRun(tx, ctx.session!.orgId, input.runId);
      // M3.33 (2026-05-18, Wave1 #3): scope check. Without this, any
      // actor with run.eject_session could pop another store's
      // session out of a run regardless of their store binding.
      // Match the gate already on runSimpleCommand-driven actions.
      const session = await tx.query.orderSessionsV.findFirst({
        where: (sess, { eq: eq2, and: and2 }) =>
          and2(eq2(sess.id, input.sessionId), eq2(sess.orgId, ctx.session!.orgId)),
        columns: { storeId: true },
      });
      if (!session) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'order.errors.sessionMissing' });
      }
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        session.storeId,
        ctx.session!.permissions,
      );

      const runEvents = (await readStream(tx, 'run', input.runId)) as unknown as RunEvent[];
      let runState = emptyRunState(input.runId);
      for (const e of runEvents) runState = applyRun(runState, e);

      // Check no per-session items have been touched yet.
      const sessionItems = await tx.query.orderItemsV.findMany({
        where: (it, { eq: eq2 }) => eq2(it.sessionId, input.sessionId),
      });
      for (const i of sessionItems) {
        const runItem = runState.items.get(i.skuId);
        if (runItem && runItem.status !== 'pending') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'order.errors.cannotEject',
          });
        }
      }

      const removedBySku = new Map<string, number>();
      for (const item of sessionItems) {
        const qty = Number(item.qty);
        if (qty <= 0) continue;
        removedBySku.set(item.skuId, (removedBySku.get(item.skuId) ?? 0) + qty);
      }
      const removedPlannedItems = [...removedBySku.entries()].map(([skuId, qty]) => ({
        skuId,
        qty: qty.toString(),
      }));

      try {
        const runRemovalEvents = decideRun(runState, {
          type: 'EjectSession',
          sessionId: input.sessionId,
          removedPlannedItems,
          reason: input.reason,
          actor: actorFromCtx(ctx),
        });
        if (runRemovalEvents.length > 0) {
          await appendEvents(tx, {
            streamType: 'run',
            streamId: run.id,
            orgId: ctx.session!.orgId,
            events: runRemovalEvents.map((e) => ({ ...e })),
          });
          for (const e of runRemovalEvents) runState = applyRun(runState, e);
          await projectRun(tx, ctx.session!.orgId, runRemovalEvents);
          await dispatchRunEventNotifications(
            tx,
            ctx.session!.orgId,
            ctx.session!.userId,
            runState,
            runRemovalEvents,
          );
        }
      } catch (err) {
        if (err instanceof DomainError) rethrowDomainError(err);
        throw err;
      }

      // Emit EjectedFromRun on the order stream in the same tx.
      const orderEvents = (await readStream(tx, 'order', input.sessionId)) as unknown as OrderEvent[];
      let oState = emptyOrderState(input.sessionId);
      for (const e of orderEvents) oState = applyOrder(oState, e);
      const ev = decideOrder(oState, {
        type: 'EjectFromRun',
        runId: input.runId,
        reason: input.reason,
        actor: {
          userId: ctx.session!.userId,
          memberId: ctx.session!.memberId,
          permissions: ctx.session!.permissions,
          isClaimer: oState.claimedByMemberId === ctx.session!.memberId,
        },
      });
      if (ev.length > 0) {
        await appendEvents(tx, {
          streamType: 'order',
          streamId: input.sessionId,
          orgId: ctx.session!.orgId,
          events: ev.map((e) => ({ ...e })),
        });
        await projectOrder(tx, ctx.session!.orgId, ev);
      }
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: runState.streamId,
        lastSeq: runState.seq,
      });
      hub.publish(ctx.session!.orgId, {
        type: 'order.changed',
        orgId: ctx.session!.orgId,
        sessionId: input.sessionId,
        lastSeq: ev[ev.length - 1]?.seq ?? oState.seq,
      });
      return { lastSeq: runState.seq, orderLastSeq: ev[ev.length - 1]?.seq ?? oState.seq };
    });
  }),
});

function actorFromCtx(
  ctx: Awaited<ReturnType<typeof import('../context').createContext>>,
  /**
   * Optional override for `permissions` — used by store-keyed commands
   * (`deliverToStore`, `confirmStore`, `confirmStoreItem`,
   * `undeliverStore`) to inject the per-store effective set after
   * applying allow/deny overrides for that specific store. Other run
   * commands aggregate across stores so this stays the flat set.
   * (Added 2026-05-06.)
   */
  effectivePermissions?: ReadonlySet<string>,
) {
  return {
    userId: ctx.session!.userId,
    memberId: ctx.session!.memberId,
    permissions: effectivePermissions ?? ctx.session!.permissions,
  };
}

async function runSimpleCommand(
  ctx: Awaited<ReturnType<typeof import('../context').createContext>>,
  runId: string,
  produce: (state: RunState) => RunEvent[],
): Promise<{ lastSeq: number }> {
  return ctx.withOrg(async (tx) => {
    const run = await loadRun(tx, ctx.session!.orgId, runId);
    await assertRunStoreVisible(tx, ctx, run);
    const events = (await readStream(tx, 'run', run.id)) as unknown as RunEvent[];
    let state = emptyRunState(run.id);
    for (const e of events) state = applyRun(state, e);
    try {
      const out = produce(state);
      if (out.length === 0) return { lastSeq: state.seq };
      await appendEvents(tx, {
        streamType: 'run',
        streamId: run.id,
        orgId: ctx.session!.orgId,
        events: out.map((e) => ({ ...e })),
      });
      for (const e of out) state = applyRun(state, e);
      await projectRun(tx, ctx.session!.orgId, out);
      await dispatchRunEventNotifications(tx, ctx.session!.orgId, ctx.session!.userId, state, out);
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: state.streamId,
        lastSeq: state.seq,
      });
      return { lastSeq: state.seq };
    } catch (err) {
      if (err instanceof DomainError) rethrowDomainError(err);
      if (isUniqueViolation(err)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'run.errors.staleSeq' });
      }
      throw err;
    }
  });
}

async function loadRun(db: import('@compass/db').DB, orgId: string, runId: string) {
  const row = await db.query.marketRunsV.findFirst({
    where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.id, runId), eq2(r.orgId, orgId)),
  });
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.streamMissing' });
  return row;
}

/**
 * Resolve every storeId touched by a run's sessions (DISTINCT). Used by
 * run.get / run.list / ejectSession store-scope checks (M3.33 Wave1 #2+#3).
 * The session_ids_json column is the source of truth; sessions can be
 * eject-removed but we deliberately do NOT drop them from the JSON
 * (sessionIds remains the historical attachment ledger). For scope
 * checking we treat both still-attached and historically-attached
 * sessions as "involved" — eject doesn't revoke the operator's right
 * to see what they previously planned for.
 */
async function runInvolvedStoreIds(
  db: import('@compass/db').DB,
  run: { sessionIdsJson: unknown },
): Promise<string[]> {
  const sessionIds = (run.sessionIdsJson as unknown as string[] | null) ?? [];
  if (sessionIds.length === 0) return [];
  const rows = await db.query.orderSessionsV.findMany({
    where: (sess, { inArray }) => inArray(sess.id, sessionIds),
    columns: { storeId: true },
  });
  return [...new Set(rows.map((r) => r.storeId))];
}

/**
 * Store-scope gate for run MUTATIONS. Mirrors the exact predicate
 * `run.get` uses (M3.33 Wave1 #2) so mutation visibility == read
 * visibility: a store-tier actor may only act on a run whose sessions
 * touch at least one store they are bound to. Org-tier actors
 * (`run.create.org`) and admins (`getActorStoreIds` → null) bypass.
 *
 * P0 H1 (2026-07-03): without this, every run mutation routed through
 * `runSimpleCommand` — plus `finish`/`cancel` which inline `loadRun` —
 * checked only org membership. A purchaser bound to Store A could
 * claim / purchaseItem / revisePurchase / addExpense / finish / cancel a
 * run that exclusively serves Store B (money-bearing cross-store writes
 * the read side already forbade). This intentionally does NOT tighten
 * beyond `run.get`: anyone who can currently see a run can still act on
 * it (subject to the domain-layer permission checks).
 */
async function assertRunStoreVisible(
  db: import('@compass/db').DB,
  ctx: Awaited<ReturnType<typeof import('../context').createContext>>,
  run: { sessionIdsJson: unknown },
): Promise<void> {
  if (ctx.session!.permissions.has('run.create.org')) return;
  const allowedStoreIds = await getActorStoreIds(
    db,
    ctx.session!.memberId,
    ctx.session!.permissions,
  );
  if (allowedStoreIds === null) return; // unrestricted (admin path)
  const involvedStoreIds = await runInvolvedStoreIds(db, run);
  const allowed = new Set(allowedStoreIds);
  if (!involvedStoreIds.some((sid) => allowed.has(sid))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505',
  );
}
