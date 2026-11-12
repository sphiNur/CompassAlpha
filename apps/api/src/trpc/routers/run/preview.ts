/**
 * What a new run would carry (run.previewCreatable), and the supplier a
 * product is bought from by default.
 */
import { TRPCError } from '@trpc/server';
import { eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { RunPreviewInputSchema, estimateOrder } from '@compass/contracts';
import { sumDemand, sumDemandBy } from '@compass/domain/run';
import { resolveRunCreateStoreScope } from '../../../services/storeScope';
import { authedProcedure } from '../../trpc';
import { priceStoreIds, pricesVisibleFor } from '../../../services/priceRedaction';
import {
  notesAndExtrasByStore,
  senderName,
  senderNames,
  storedExtras,
} from '../../../services/runSessionsView';
import { inUuids } from '../../../services/sqlIn';
import { executeRows } from '../../../services/sqlRows';
import { orgToday } from '../../../services/timeZone';

export const previewProcedures = {
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
  previewCreatable: authedProcedure.input(RunPreviewInputSchema).query(async ({ ctx, input }) => {
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
      // 2026-10-21 CA-03: the org's business "today", so the client can
      // pre-select only today's orders and flag older ones — the device
      // clock is the wrong timezone for a purchaser travelling or a
      // phone set to UTC.
      const today = orgToday(ctx.session);
      // M3.2: org-wide visibility requires `run.create.org` (or the
      // legacy `users.manage` super-perm). Without it, scope the
      // query to the actor's bound stores. `getActorStoreIds`
      // returns `null` for org-tier actors (skip filter), an
      // explicit array for store-tier actors.
      const allowedStoreIds = await resolveRunCreateStoreScope(tx, ctx.session!);
      const sessions = await tx.query.orderSessionsV.findMany({
        where: (sess, { eq: eq2, and: and2, inArray: inArray2 }) => {
          const base = [eq2(sess.orgId, ctx.session!.orgId), eq2(sess.status, 'approved')];
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
          today,
          sessions: [],
          plannedItems: [],
          perStoreDemand: [],
          perSessionDemand: [] as Array<{ sessionId: string; skuId: string; qty: string }>,
          supplierBySku: {} as Record<
            string,
            {
              id: string;
              name: string;
              contactPhone: string | null;
              contactTg: string | null;
              defaultPrice: string | null;
              lastSeenPrice: string | null;
              estimatedUnitPrice: string | null;
            } | null
          >,
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

      // Summed by the domain as run.create sums them (review RUNAPI-13),
      // in whole thousandths (RUNAPI-05).
      const plannedItems = sumDemand(items);
      const demandByStore = sumDemandBy(items, (it) => storeBySession.get(it.sessionId));
      // 2026-10-21 CA-03: demand per SESSION, so the client can
      // re-aggregate the preview over the sessions the purchaser ticked
      // without a round trip per checkbox.
      const demandBySession = sumDemandBy(items, (it) => it.sessionId);

      // Resolve store display names in one query — the FE renders
      // "🏪 {name}" headings so we'd otherwise need session.stores
      // (which only covers the actor's accessible stores). For an
      // admin viewing an org-wide preview we want every involved
      // store's name, not just theirs.
      const involvedStoreIds = [
        ...new Set([...demandByStore.keys(), ...sessions.map((s) => s.storeId)]),
      ];
      // M1.9-fix (2026-05-07): storeName was '—' for every store on the
      // by-store preview; the store lookup now uses `inArray()`, which
      // expands to a proper IN-list. (Review RUNAPI-16: in drizzle 0.45 a
      // bare `IN ${array}` expands too, but `= ANY(${array})` does not.)
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
      }> = [...demandByStore].flatMap(([storeId, demand]) =>
        demand.map(({ skuId, qty }) => ({
          storeId,
          storeName: storeNameById.get(storeId) ?? '—',
          skuId,
          qty,
        })),
      );

      // Resolve preferred supplier per SKU. DISTINCT ON (sku_id) +
      // ORDER BY is_preferred DESC, last_seen_at DESC NULLS LAST
      // gives us "the best link per SKU". Only one query for all
      // planned SKUs.
      const skuIds = plannedItems.map((item) => item.skuId);
      const supplierBySku: Record<
        string,
        {
          id: string;
          name: string;
          contactPhone: string | null;
          contactTg: string | null;
          defaultPrice: string | null;
          lastSeenPrice: string | null;
          estimatedUnitPrice: string | null;
        } | null
      > = {};
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
        for (const r of executeRows<(typeof rows)[number]>(rows)) {
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
              AND ph.superseded_at IS NULL
              AND ph.sku_id IN ${inUuids(skuIds)}
            ORDER BY ph.sku_id, ph.observed_at DESC, ph.created_at DESC
          `);
        for (const price of executeRows<(typeof priceRows)[number]>(priceRows)) {
          lastPurchasePriceBySku[price.sku_id] = price.unit_price;
        }
      }

      // M1.8 (2026-05-07): bundle the session-level "其他物品" notes
      // by store so the FE can show them inline next to that store's
      // demand block. M3.16-C (2026-05-16): also the structured
      // `extras`, each with its session and index (M3.37) so a tap can
      // mark it. Both are sent while sessions with the legacy notes
      // remain.
      const { sessionNotesByStore, sessionExtrasByStore } = notesAndExtrasByStore(sessions);

      // ORD-01: D1 money lines added in cents, as every estimate is.
      const perStoreBudgets = involvedStoreIds.map((storeId) => {
        const est = estimateOrder(
          demandByStore.get(storeId) ?? [],
          (skuId) =>
            lastPurchasePriceBySku[skuId] ?? supplierBySku[skuId]?.estimatedUnitPrice ?? null,
        );
        return {
          storeId,
          storeName: storeNameById.get(storeId) ?? '—',
          estimatedTotal: est.total,
          unknownPriceCount: est.unknown,
        };
      });

      const perSessionDemand: Array<{ sessionId: string; skuId: string; qty: string }> = [
        ...demandBySession,
      ].flatMap(([sessionId, demand]) => demand.map((line) => ({ sessionId, ...line })));

      // D6 (2026-10-31): a planner without prices.view in every store of
      // the plan gets quantities only — no stall prices, last paid prices
      // or budgets.
      const showPrices = pricesVisibleFor(await priceStoreIds(tx, ctx.session!), involvedStoreIds);
      if (!showPrices) {
        for (const skuId of Object.keys(supplierBySku)) {
          const supplier = supplierBySku[skuId];
          if (supplier) {
            supplierBySku[skuId] = {
              ...supplier,
              defaultPrice: null,
              lastSeenPrice: null,
              estimatedUnitPrice: null,
            };
          }
        }
      }
      // Walkthrough F6 (2026-11-05): the picker listed "Central Kitchen"
      // four times with nothing to tell the orders apart. Who sent each
      // one, and when, is added (new fields; nothing existing changes).
      const submitterNames = await senderNames(tx, sessions);
      return {
        date,
        today,
        sessions: sessions.map((sess) => ({
          id: sess.id,
          storeId: sess.storeId,
          storeName: storeNameById.get(sess.storeId) ?? '—',
          orderDate: sess.orderDate,
          submittedByMemberId: sess.submittedByMemberId,
          submittedByName: senderName(submitterNames, sess),
          submittedAt: sess.submittedAt ? sess.submittedAt.toISOString() : null,
          notes: sess.notes,
          extras: storedExtras(sess.extrasJson),
        })),
        plannedItems,
        perStoreDemand,
        perSessionDemand,
        supplierBySku,
        lastPurchasePriceBySku: showPrices ? lastPurchasePriceBySku : {},
        // Hidden budgets are left out rather than nulled: clients decode
        // estimatedTotal as a string (the Fine app fails the whole preview
        // on a null there).
        perStoreBudgets: showPrices ? perStoreBudgets : [],
        /** Per-store concatenated session notes (M1.8, legacy). Empty
         *  record when no notes anywhere. */
        sessionNotesByStore,
        /** Per-store structured extras (M3.16-C). Empty record when
         *  no extras anywhere. */
        sessionExtrasByStore,
        total: plannedItems.length,
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
          where: (k, { eq: eq2, and: and2 }) => and2(eq2(k.id, input.skuId), eq2(k.orgId, orgId)),
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
};
