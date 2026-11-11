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
import { logger } from '../../infra/log';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { schema as s, type DB } from '@compass/db';
import {
  AddPurchaserItemInputSchema,
  AddRunExpenseInputSchema,
  ConfirmStoreInputSchema,
  ConfirmStoreItemInputSchema,
  DispatchInputSchema,
  EjectSessionInputSchema,
  MarkUnavailableInputSchema,
  MarkStoreItemsOkInputSchema,
  PurchaseItemInputSchema,
  RemoveRunExpenseInputSchema,
  RevisePurchaseInputSchema,
  RunAttachSessionsInputSchema,
  RunCancelInputSchema,
  RunCreateInputSchema,
  RunPreviewInputSchema,
  RunHistoryInputSchema,
  ChangeRunDateInputSchema,
  RunReasonOnlyInputSchema,
  SimpleRunCommandSchema,
  UndeliverStoreInputSchema,
  UndoPurchaseInputSchema,
  UnmarkUnavailableInputSchema,
  DismissTopUpInputSchema,
  centsToMoney,
  estimateOrder,
  lineAmount,
  milliQty,
  qtyMilli,
  sumMoney,
  toCents,
} from '@compass/contracts';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
  getActorStoreIds,
  getActorStoreIdsForPermission,
  resolveRunCreateStoreScope,
} from '../../services/storeScope';
import { hasGlobalPermission } from '../../services/orgAdmin';
import {
  applyRun,
  decideRun,
  emptyRunState,
  replayRun,
  type RunEvent,
  type RunState,
} from '@compass/domain/run';
import { decide as decideOrder, type OrderEvent, type OrderState } from '@compass/domain/order';
import { DomainError } from '@compass/domain';
import { authedProcedure, idempotentMutation, rethrowDomainError, router } from '../trpc';
import type { RequestContext } from '../context';
import {
  canSeePrices,
  priceStoreIds,
  pricesVisibleFor,
  withoutPrices,
} from '../../services/priceRedaction';
import {
  isStreamSeqConflict,
  isUniqueViolation,
  pgConstraintName,
  withStreamConflictRetry,
} from '../../services/pgErrors';
import { runCorrections } from '../../services/runCorrections';
import { loadRunState, readRunEvents } from '../../services/runStream';
import { loadOrderState } from '../../services/orderStream';
import {
  expensesForReader,
  itemsForStoreReader,
  splitsForReader,
} from '../../services/runReaderView';
import {
  loadRunSessions,
  notesAndExtrasByStore,
  runSessionsView,
  senderName,
  senderNames,
  storedExtras,
} from '../../services/runSessionsView';
import { writeOrderEvents, writeRunEvents } from '../../services/streamWrite';
import { hub } from '../../realtime/hub';
import { dispatchRunEventNotifications } from '../../services/notifyForEvent';
import {
  moneyText,
  runDetailMoney,
  runMoneyLinesSql,
  uuidListSql,
  type RunMoneyLine,
} from '../../services/runMoney';
import { inUuids } from '../../services/sqlIn';
import { executeRows } from '../../services/sqlRows';
import { todayInTz } from '@compass/domain';
import {
  hiddenSplits,
  mergeScopedRevision,
  splitsInheritingItemPayment,
  StoreOutOfScopeError,
} from '../../services/scopedRunRevision';
import { readExpenseTemplates } from '../../services/expenseTemplates';

/** run.list / run.get answer without money to members lacking prices.view. */
const runReadProcedure = authedProcedure.use(async (opts) => {
  const result = await opts.next();
  if (result.ok && !canSeePrices(opts.ctx.session)) {
    return { ...result, data: withoutPrices(result.data) };
  }
  return result;
});

/** Runs not finished or cancelled: run.list keeps them whatever their age (RUNAPI-06). */
const OPEN_RUN_STATUSES = ['planned', 'purchasing', 'delivering', 'amending'];

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
    return ctx.withOrg((tx) => readExpenseTemplates(tx, ctx.session!, false));
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
      const today = todayStr(ctx);
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

      // RUNAPI-05: quantities in whole thousandths (bigint), not floats.
      const aggregated = new Map<string, bigint>();
      const perStoreSkuQty = new Map<string, Map<string, bigint>>(); // storeId → skuId → qty
      // 2026-10-21 CA-03: demand per SESSION, so the client can
      // re-aggregate the preview over the sessions the purchaser ticked
      // without a round trip per checkbox.
      const perSessionSkuQty = new Map<string, Map<string, bigint>>();
      for (const it of items) {
        const qty = qtyMilli(it.qty);
        if (qty <= 0n) continue;
        aggregated.set(it.skuId, (aggregated.get(it.skuId) ?? 0n) + qty);
        const bySession = perSessionSkuQty.get(it.sessionId) ?? new Map<string, bigint>();
        bySession.set(it.skuId, (bySession.get(it.skuId) ?? 0n) + qty);
        perSessionSkuQty.set(it.sessionId, bySession);
        const sid = storeBySession.get(it.sessionId);
        if (!sid) continue;
        const inner = perStoreSkuQty.get(sid) ?? new Map<string, bigint>();
        inner.set(it.skuId, (inner.get(it.skuId) ?? 0n) + qty);
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
      }> = [];
      for (const [sid, inner] of perStoreSkuQty.entries()) {
        const storeName = storeNameById.get(sid) ?? '—';
        for (const [skuId, qty] of inner.entries()) {
          perStoreDemand.push({
            storeId: sid,
            storeName,
            skuId,
            qty: milliQty(qty),
          });
        }
      }

      // Resolve preferred supplier per SKU. DISTINCT ON (sku_id) +
      // ORDER BY is_preferred DESC, last_seen_at DESC NULLS LAST
      // gives us "the best link per SKU". Only one query for all
      // planned SKUs.
      const skuIds = [...aggregated.keys()];
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
          [...(perStoreSkuQty.get(storeId)?.entries() ?? [])].map(([skuId, qty]) => ({
            skuId,
            qty: milliQty(qty),
          })),
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

      const perSessionDemand: Array<{ sessionId: string; skuId: string; qty: string }> = [];
      for (const [sessionId, inner] of perSessionSkuQty.entries()) {
        for (const [skuId, qty] of inner.entries()) {
          perSessionDemand.push({ sessionId, skuId, qty: milliQty(qty) });
        }
      }

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
        plannedItems: [...aggregated.entries()].map(([skuId, qty]) => ({
          skuId,
          qty: milliQty(qty),
        })),
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
    // BUY-12 (2026-10-30): a double tap raced on the orders' streams and
    // answered 500; decided again, the second finds the run the first made.
    // RUNAPI-04: the same for a race on the run's own unique indexes.
    return withRunStreamRetry(ctx, async (tx) => {
      const today = todayStr(ctx);
      const date = input.date ?? today;

      /**
       * One non-terminal run per org (migration 0035, 2026-07-26).
       *
       * Return the live run instead of failing. This procedure is about
       * to be called implicitly — Q7(a) drops the explicit "new run"
       * button and creates the run on the purchaser's first recorded
       * action — so "there is already one" is the normal case, not an
       * error. Making it idempotent here means the caller can just ask
       * for a run id and get the right one.
       *
       * Sessions are deliberately NOT attached to the returned run.
       * Anything still plannable while a run is open belongs to
       * run.attachSessions, which has its own guards for the run's
       * status; quietly folding that into create would make one
       * procedure mean two things.
       *
       * 2026-10-21 CA-04: only a planned/purchasing run is "the live
       * run" now (migration 0047 narrowed the unique index to match). A
       * run that is out for delivery no longer blocks a new trip — it
       * used to, and one store that never confirmed froze purchasing for
       * the whole organisation.
       */
      const live = await tx.query.marketRunsV.findFirst({
        where: (r, { eq: eq2, and: and2, inArray: inArray2 }) =>
          and2(eq2(r.orgId, ctx.session!.orgId), inArray2(r.status, ['planned', 'purchasing'])),
      });
      if (live) {
        // Returning an existing live run is still a run.create operation.
        // A Store-A purchaser must not learn/reuse a Store-B-only run merely
        // because a store-scoped custom role leaked `run.create.org` into the
        // flat session union.
        await assertRunCreateScopeForRun(tx, ctx, live);
        return { runId: live.id, runIndex: live.runIndex, lastSeq: live.lastSeq, reused: true };
      }

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
      // A global preview/create scope must come from a persisted GLOBAL
      // `run.create.org` grant. Otherwise resolve `run.create` at each
      // concrete store, so Store-A purchaser + Store-B staff membership
      // cannot combine into Store-B planning authority.
      const allowedStoreIds = await resolveRunCreateStoreScope(tx, ctx.session!);
      assertStoreIdsWithinRunCreateScope(
        sessions.map((session) => session.storeId),
        allowedStoreIds,
      );

      // 2026-10-21 CA-03: the purchaser may book the run under an earlier
      // date (yesterday's orders bought this morning), but never a date
      // the calendar doesn't have (2026-02-31 would roll into March) or
      // one in the future (org timezone). Checked after the store-scope
      // gate so an out-of-scope request reports the permission problem.
      {
        const parsed = new Date(`${date}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'run.errors.invalidRunDate' });
        }
        if (date > today) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'run.errors.runDateInFuture' });
        }
      }

      // Aggregate items across sessions.
      const items = await tx.query.orderItemsV.findMany({
        where: (it, { inArray: inArray2 }) => inArray2(it.sessionId, input.sessionIds),
      });
      // RUNAPI-05: in whole thousandths; the strings go into RunPlanned.
      const aggregated = new Map<string, bigint>();
      for (const it of items) {
        const qty = qtyMilli(it.qty);
        if (qty <= 0n) continue;
        aggregated.set(it.skuId, (aggregated.get(it.skuId) ?? 0n) + qty);
      }
      const plannedItems = [...aggregated.entries()].map(([skuId, qty]) => ({
        skuId,
        qty: milliQty(qty),
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
          actor: actorFromCtx(ctx),
        });
        // M1.13 (2026-05-08): atomic plan + start. The FE collapsed
        // the "+ New run" / "Start purchase" double-tap. Fold the
        // PlanRun events forward, then ask the aggregate to emit
        // StartPurchase against that fresh state. Both event sets
        // commit in the same DB transaction below — projection lag
        // never sees a half-state. Single-step callers (older clients
        // and tests) still get the original two-event flow.
        if (input.startImmediately) {
          const startEvents = decideRun(events.reduce(applyRun, state), {
            type: 'StartPurchase',
            actor: actorFromCtx(ctx),
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
        // 2026-07-26: the projection (in writeRunEvents) moved INSIDE the
        // try. It is where market_runs_v is actually inserted, so it is
        // where both unique constraints can fire — (org, date, index) if
        // two callers computed the same next index, and the new
        // one-active-per-org index if another caller created a run
        // between this one's `live` check above and this insert. Outside
        // the try, either surfaced as a 500.
        //
        // The transaction is aborted by then, so it cannot re-read to
        // find the winner. RUNAPI-04 (2026-11-09): the error goes out as
        // it is, and withRunStreamRetry runs the whole transaction again;
        // the next attempt hits the `live` short-circuit and returns the
        // run that won.
        await writeRunEvents(tx, ctx.session!.orgId, state, events);
      } catch (err) {
        if (isRunSlotConflict(err)) throw err;
        if (isUniqueViolation(err)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'run.errors.alreadyPlanned' });
        }
        throw err;
      }

      // Emit AttachedToRun on each session stream.
      const attachedSessions = await attachSessionsToRun(tx, ctx, runId, input.sessionIds);

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

      return {
        runId,
        runIndex,
        lastSeq: events[events.length - 1]?.seq ?? 0,
        reused: false,
      };
    }, runCreateRetryable);
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
      return withRunStreamRetry(ctx, async (tx) => {
        const run = await loadRun(tx, ctx.session!.orgId, input.runId);
        await assertRunCreateScopeForRun(tx, ctx, run);
        if (run.status === 'amending') await assertCanAmendRun(tx, ctx, run);
        if (run.status !== 'planned' && run.status !== 'purchasing') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'run.errors.cannotAttachInStatus',
          });
        }
        const alreadyIn = new Set(run.sessionIdsJson);
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
        const allowedStoreIds = await resolveRunCreateStoreScope(tx, ctx.session!);
        assertStoreIdsWithinRunCreateScope(
          sessions.map((session) => session.storeId),
          allowedStoreIds,
        );

        // Aggregate items across the new sessions only — these become
        // the delta. The run state reducer merges them on top of
        // whatever's already planned.
        const items = await tx.query.orderItemsV.findMany({
          where: (it, { inArray: inArray2 }) => inArray2(it.sessionId, dedupedNewIds),
        });
        // RUNAPI-05: in whole thousandths, as in run.create.
        const aggregated = new Map<string, bigint>();
        for (const it of items) {
          const qty = qtyMilli(it.qty);
          if (qty <= 0n) continue;
          aggregated.set(it.skuId, (aggregated.get(it.skuId) ?? 0n) + qty);
        }
        const addedPlannedItems = [...aggregated.entries()].map(([skuId, qty]) => ({
          skuId,
          qty: milliQty(qty),
        }));

        // Replay the run aggregate, then decide AttachSessions.
        const runState = await loadRunState(tx, run.id);
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
        await writeRunEvents(tx, ctx.session!.orgId, runState, producedEvents);

        // Move each attached session's stream from approved → in_run.
        const attachedSessions = await attachSessionsToRun(tx, ctx, run.id, dedupedNewIds);

        // 2026-10-21 audit CA-31: same broadcast as `create` — without it
        // other purchasers' Run page and the attached sessions' Order /
        // Approval screens stayed stale and kept offering actions the
        // server now rejects. (Notifications stay off, as in `create`.)
        const runLastSeq = producedEvents[producedEvents.length - 1]?.seq ?? runState.seq;
        hub.publish(ctx.session!.orgId, {
          type: 'run.changed',
          orgId: ctx.session!.orgId,
          runId: run.id,
          lastSeq: runLastSeq,
        });
        for (const a of attachedSessions) {
          hub.publish(ctx.session!.orgId, {
            type: 'order.changed',
            orgId: ctx.session!.orgId,
            sessionId: a.sessionId,
            lastSeq: a.lastSeq,
          });
        }

        return {
          runId: run.id,
          attached: dedupedNewIds,
          lastSeq: producedEvents[producedEvents.length - 1]?.seq ?? runState.seq,
        };
      });
    }),

  list: runReadProcedure.query(async ({ ctx }) => {
    return ctx.withOrg(async (tx) => {
      // A flat session permission is a union across role scopes and cannot
      // prove organization-wide read authority. Resolve the persisted
      // provenance first; store-scoped readers receive a redacted projection
      // below rather than the raw cross-store run row.
      const allowedStoreIds = await resolveRunReadStoreScope(tx, ctx);
      if (allowedStoreIds !== null && allowedStoreIds.length === 0) return [];
      // Review RUNAPI-06 (2026-11-09): the store scope is applied in SQL,
      // before the limit, as run.history does; and a run still open is
      // listed however old it is. The org's newest 50 were taken first and
      // filtered after, so a store reader could get far fewer than 50, and
      // a run waiting for a store's receipt fell off the receiving page
      // once 50 newer runs existed: that store could never confirm it, and
      // the run could never finish.
      const visibleToReader =
        allowedStoreIds === null
          ? undefined
          : sql`EXISTS (
              SELECT 1 FROM read_model.order_sessions_v os
              WHERE os.org_id = ${ctx.session!.orgId}
                AND os.store_id IN (${uuidListSql(allowedStoreIds)})
                AND os.id IN (
                  SELECT (jsonb_array_elements_text(${s.marketRunsV.sessionIdsJson}))::uuid
                )
            )`;
      const orgRuns = and(eq(s.marketRunsV.orgId, ctx.session!.orgId), visibleToReader);
      const newestFirst = [desc(s.marketRunsV.runDate), desc(s.marketRunsV.runIndex)] as const;
      const open = await tx
        .select()
        .from(s.marketRunsV)
        .where(and(orgRuns, inArray(s.marketRunsV.status, OPEN_RUN_STATUSES)))
        .orderBy(...newestFirst);
      const recent = await tx
        .select()
        .from(s.marketRunsV)
        .where(orgRuns)
        .orderBy(...newestFirst)
        .limit(50);
      const recentIds = new Set(recent.map((r) => r.id));
      const runs = [...recent, ...open.filter((r) => !recentIds.has(r.id))].sort(
        (a, b) => b.runDate.localeCompare(a.runDate) || b.runIndex - a.runIndex,
      );
      // Resolve every involved storeId in one shot; cheap join on a
      // bounded result set.
      const allSessionIds = [...new Set(runs.flatMap((r) => r.sessionIdsJson))];
      const allowedStoreSet = allowedStoreIds === null ? null : new Set(allowedStoreIds);
      // D6 (2026-10-31): money per run only where prices.view holds in
      // every store of the run the reader sees.
      const priceStores = await priceStoreIds(tx, ctx.session!);
      const sessionStore = new Map<string, string>();
      // DX-DLV-13 (2026-11-01): always resolved now — each row names the
      // visible stores it serves (`storeIds`), so a store's receiving page
      // can tell "on the way" from "nothing for you".
      if (allSessionIds.length > 0) {
        const sessionStoreRows = await tx.query.orderSessionsV.findMany({
          where: (sess, { inArray }) => inArray(sess.id, allSessionIds),
          columns: { id: true, storeId: true },
        });
        for (const row of sessionStoreRows) sessionStore.set(row.id, row.storeId);
      }
      const visibleRuns = runs;
      if (visibleRuns.length === 0) return [];

      // 2026-10-21 CA-11: per-store money now comes from the shared
      // money-line SQL (services/runMoney.ts) — items at COALESCE(split
      // override, item price) PLUS active expenses — so run.list agrees
      // with run.history and report.*. Before, this was items-only JS
      // float math and silently dropped expenses.
      // D1 (2026-10-31): integer cents — the lines are rounded to cents
      // in SQL, and adding them as floats could drift.
      type MutableStoreTotal = {
        storeId: string;
        total: bigint;
        itemsTotal: bigint;
        expensesTotal: bigint;
        cash: bigint;
        transfer: bigint;
        /** Items-only cash/transfer — partitions the frozen actual_total. */
        itemsCash: bigint;
        itemsTransfer: bigint;
        itemCount: number;
      };
      const totalsByRun = new Map<string, Map<string, MutableStoreTotal>>();
      const visibleRunIds = visibleRuns.map((r) => r.id);
      const moneyRows = executeRows<{
        run_id: string;
        store_id: string;
        total: string;
        items_total: string;
        expenses_total: string;
        cash: string;
        transfer: string;
        items_cash: string;
        items_transfer: string;
        item_count: number;
      }>(
        await tx.execute(sql`
          WITH money_lines AS (
            ${runMoneyLinesSql({
              runsSql: sql`(SELECT unnest(ARRAY[${uuidListSql(visibleRunIds)}]::uuid[]) AS id)`,
              storeIdsSql: uuidListSql(allowedStoreIds),
            })}
          )
          SELECT
            run_id::text AS run_id,
            store_id::text AS store_id,
            COALESCE(SUM(amount), 0)::text AS total,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'item'), 0)::text AS items_total,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::text AS expenses_total,
            COALESCE(SUM(amount) FILTER (WHERE payment_method = 'transfer'), 0)::text AS transfer,
            COALESCE(SUM(amount) FILTER (WHERE payment_method <> 'transfer'), 0)::text AS cash,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'item' AND payment_method = 'transfer'), 0)::text
              AS items_transfer,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'item' AND payment_method <> 'transfer'), 0)::text
              AS items_cash,
            (COUNT(DISTINCT sku_id) FILTER (WHERE sku_id IS NOT NULL))::int AS item_count
          FROM money_lines
          GROUP BY run_id, store_id
        `),
      );
      for (const row of moneyRows) {
        let runTotals = totalsByRun.get(row.run_id);
        if (!runTotals) {
          runTotals = new Map<string, MutableStoreTotal>();
          totalsByRun.set(row.run_id, runTotals);
        }
        runTotals.set(row.store_id, {
          storeId: row.store_id,
          total: toCents(row.total),
          itemsTotal: toCents(row.items_total),
          expensesTotal: toCents(row.expenses_total),
          cash: toCents(row.cash),
          transfer: toCents(row.transfer),
          itemsCash: toCents(row.items_cash),
          itemsTransfer: toCents(row.items_transfer),
          itemCount: row.item_count,
        });
      }

      const moneyString = centsToMoney;
      const sumCents = (values: bigint[]) => values.reduce((sum, v) => sum + v, 0n);
      const runStoreIds = (run: (typeof visibleRuns)[number]): string[] => {
        const ids = new Set<string>();
        for (const sessionId of run.sessionIdsJson) {
          const storeId = sessionStore.get(sessionId);
          if (storeId !== undefined && (!allowedStoreSet || allowedStoreSet.has(storeId))) {
            ids.add(storeId);
          }
        }
        for (const storeId of totalsByRun.get(run.id)?.keys() ?? []) ids.add(storeId);
        return [...ids];
      };
      return visibleRuns.map((run) => {
        const storeIds = runStoreIds(run);
        const row = { ...listRow(run), storeIds };
        return pricesVisibleFor(priceStores, storeIds) ? row : withoutPrices(row);
      });

      function listRow(run: (typeof visibleRuns)[number]) {
        const storeTotalRows = [...(totalsByRun.get(run.id)?.values() ?? [])].sort((a, b) =>
          b.total > a.total ? 1 : b.total < a.total ? -1 : 0,
        );
        const storeTotals = storeTotalRows.map((total) => ({
          storeId: total.storeId,
          total: moneyString(total.total),
          itemsTotal: moneyString(total.itemsTotal),
          expensesTotal: moneyString(total.expensesTotal),
          cash: moneyString(total.cash),
          transfer: moneyString(total.transfer),
          itemCount: total.itemCount,
        }));
        // items / expenses / total over the visible stores, live.
        const itemsSum = sumCents(storeTotalRows.map((row) => row.itemsTotal));
        const expensesSum = sumCents(storeTotalRows.map((row) => row.expensesTotal));
        const money = {
          itemsTotal: centsToMoney(itemsSum),
          expensesTotal: centsToMoney(expensesSum),
          total: centsToMoney(itemsSum + expensesSum),
        };
        if (!allowedStoreSet) return { ...run, storeTotals, money };

        const visibleSessionIds = run.sessionIdsJson.filter((sessionId) => {
          const storeId = sessionStore.get(sessionId);
          return storeId !== undefined && allowedStoreSet.has(storeId);
        });
        // actual_total keeps its items-only meaning for partial readers too.
        const visibleActualTotal = itemsSum;
        const visibleCashTotal = sumCents(storeTotalRows.map((row) => row.itemsCash));
        const visibleTransferTotal = sumCents(storeTotalRows.map((row) => row.itemsTransfer));
        return {
          ...run,
          // These columns are aggregates over the entire run. Never expose
          // their raw values to a partial reader.
          plannedTotal: null,
          actualTotal: run.actualTotal === null ? null : moneyString(visibleActualTotal),
          actualCashTotal: run.actualCashTotal === null ? null : moneyString(visibleCashTotal),
          actualTransferTotal:
            run.actualTransferTotal === null ? null : moneyString(visibleTransferTotal),
          sessionIdsJson: visibleSessionIds,
          storeTotals,
          money,
        };
      }
    });
  }),

  /**
   * Complete finished-run history for the purchaser-facing history page.
   *
   * This is deliberately a server-side page, not `LIMIT 100` followed by
   * client filtering. Visibility, search and money filters all run before
   * LIMIT/OFFSET, and every monetary field is recomputed from the stores
   * where `prices.view` is actually effective. That matters for mixed-role
   * members (manager in A, staff in B): the flat session permission set is
   * suitable for showing the History tab, but must never authorize B's
   * financial rows or leak B's contribution through the run-level total.
   */
  history: authedProcedure.input(RunHistoryInputSchema.optional()).query(async ({ ctx, input }) =>
    ctx.withOrg(
      async (tx) => {
        const query = input ?? RunHistoryInputSchema.parse({});
        const orgId = ctx.session!.orgId;
        const permissionStoreIds = await getActorStoreIdsForPermission(
          tx,
          ctx.session!.memberId,
          'prices.view',
          ctx.session!.permissions,
        );
        if (permissionStoreIds !== null && permissionStoreIds.length === 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.missingPermission',
            cause: { missingPermission: 'prices.view' },
          });
        }

        let scopedStoreIds = permissionStoreIds;
        if (query.storeId) {
          if (permissionStoreIds !== null && !permissionStoreIds.includes(query.storeId)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'auth.errors.notAssignedToStore',
            });
          }
          const store = await tx.query.stores.findFirst({
            where: (st, { and: and2, eq: eq2 }) =>
              and2(eq2(st.id, query.storeId!), eq2(st.orgId, orgId)),
            columns: { id: true },
          });
          if (!store) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
          }
          scopedStoreIds = [query.storeId];
        }

        const storeIdsSql =
          scopedStoreIds === null
            ? null
            : sql.join(
                scopedStoreIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              );
        const splitScopeSql = storeIdsSql ? sql`AND ris.store_id IN (${storeIdsSql})` : sql``;
        const sessionScopeSql = storeIdsSql ? sql`AND os.store_id IN (${storeIdsSql})` : sql``;
        const expenseScopeSql = storeIdsSql
          ? sql`AND (expense_split.value->>'storeId')::uuid IN (${storeIdsSql})`
          : sql``;
        const visibilitySql = storeIdsSql
          ? sql`AND EXISTS (
              SELECT 1
              FROM read_model.order_sessions_v os
              WHERE os.run_id = mr.id
                AND os.org_id = ${orgId}
                ${sessionScopeSql}
            )`
          : sql``;
        const dateFromSql = query.dateFrom
          ? sql`AND mr.run_date >= ${query.dateFrom}::date`
          : sql``;
        const dateToSql = query.dateTo ? sql`AND mr.run_date <= ${query.dateTo}::date` : sql``;

        // Each token must match somewhere, while fields within a token
        // are ORed. Item/vendor and expense matches are joined to the
        // same visible store scope, preventing search-result side channels.
        const searchTokens = (query.search ?? '').trim().split(/\s+/u).filter(Boolean).slice(0, 8);
        const tokenPredicates = searchTokens.map((token) => {
          // HIS-14 (2026-10-30): "%" or "_" typed in search matched every run.
          const pattern = `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          return sql`(
            mr.run_date::text ILIKE ${pattern}
            OR ('#' || (mr.run_index + 1)::text) ILIKE ${pattern}
            OR EXISTS (
              SELECT 1
              FROM read_model.order_sessions_v os
              INNER JOIN inventory.stores st ON st.id = os.store_id
              WHERE os.run_id = mr.id
                AND os.org_id = ${orgId}
                ${sessionScopeSql}
                AND (st.name ILIKE ${pattern} OR COALESCE(st.code, '') ILIKE ${pattern})
            )
            OR EXISTS (
              SELECT 1
              FROM read_model.run_items_v ri_search
              INNER JOIN read_model.run_item_stores_v ris
                ON ris.run_id = ri_search.run_id AND ris.sku_id = ri_search.sku_id
              INNER JOIN inventory.skus sku ON sku.id = ri_search.sku_id
              LEFT JOIN inventory.suppliers supplier ON supplier.id = ri_search.supplier_id
              WHERE ri_search.run_id = mr.id
                AND ri_search.status = 'purchased'
                ${splitScopeSql}
                AND (
                  COALESCE(sku.code, '') ILIKE ${pattern}
                  OR sku.names::text ILIKE ${pattern}
                  OR sku.aliases::text ILIKE ${pattern}
                  OR COALESCE(supplier.name, '') ILIKE ${pattern}
                )
            )
            OR EXISTS (
              SELECT 1
              FROM read_model.run_expenses_v expense_search
              CROSS JOIN LATERAL jsonb_array_elements(expense_search.store_splits_json)
                AS expense_split(value)
              WHERE expense_search.run_id = mr.id
                AND expense_search.removed_at IS NULL
                ${expenseScopeSql}
                AND expense_search.label ILIKE ${pattern}
            )
          )`;
        });
        const searchSql =
          tokenPredicates.length > 0 ? sql`AND ${sql.join(tokenPredicates, sql` AND `)}` : sql``;
        const paymentSql =
          query.payment === 'cash'
            ? sql`AND COALESCE(vt.cash_total, 0) > 0
                  AND COALESCE(vt.transfer_total, 0) = 0`
            : query.payment === 'transfer'
              ? sql`AND COALESCE(vt.transfer_total, 0) > 0
                    AND COALESCE(vt.cash_total, 0) = 0`
              : query.payment === 'mixed'
                ? sql`AND COALESCE(vt.cash_total, 0) > 0
                      AND COALESCE(vt.transfer_total, 0) > 0`
                : sql``;

        const historyCte = sql`
          WITH candidate_runs AS (
            SELECT mr.*
            FROM read_model.market_runs_v mr
            WHERE mr.org_id = ${orgId}
              -- D5 (2026-10-31): the same runs finance counts; an
              -- amending run is listed with its status (修改中).
              AND mr.status IN ('finished', 'amending')
              ${dateFromSql}
              ${dateToSql}
              ${visibilitySql}
              ${searchSql}
          ),
          -- 2026-10-21 CA-11: the shared money-line definition
          -- (services/runMoney.ts) — the same rows report.* sums.
          money_lines AS (
            ${runMoneyLinesSql({ runsSql: sql`candidate_runs`, storeIdsSql })}
          ),
          visible_totals AS (
            SELECT
              run_id,
              COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'item'), 0) AS items_total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0) AS expenses_total,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0) AS cash_total,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'transfer'), 0) AS transfer_total,
              (COUNT(DISTINCT sku_id) FILTER (WHERE sku_id IS NOT NULL))::int AS item_count
            FROM money_lines
            GROUP BY run_id
          ),
          visible_store_counts AS (
            SELECT os.run_id, COUNT(DISTINCT os.store_id)::int AS store_count
            FROM read_model.order_sessions_v os
            INNER JOIN candidate_runs cr ON cr.id = os.run_id
            WHERE os.org_id = ${orgId} ${sessionScopeSql}
            GROUP BY os.run_id
          ),
          filtered AS (
            SELECT
              cr.id,
              cr.run_date,
              cr.run_index,
              cr.status,
              cr.finished_at,
              COALESCE(vt.total, 0) AS actual_total,
              COALESCE(vt.items_total, 0) AS items_total,
              COALESCE(vt.expenses_total, 0) AS expenses_total,
              COALESCE(vt.cash_total, 0) AS actual_cash_total,
              COALESCE(vt.transfer_total, 0) AS actual_transfer_total,
              COALESCE(vt.item_count, 0)::int AS item_count,
              COALESCE(vsc.store_count, 0)::int AS store_count
            FROM candidate_runs cr
            LEFT JOIN visible_totals vt ON vt.run_id = cr.id
            LEFT JOIN visible_store_counts vsc ON vsc.run_id = cr.id
            WHERE TRUE ${paymentSql}
          )
        `;

        type SummaryDbRow = {
          total_count: number;
          total: string;
          items_total: string;
          expenses_total: string;
          cash: string;
          transfer: string;
        };
        const summaryRows = executeRows<SummaryDbRow>(
          await tx.execute(sql`
          ${historyCte}
          SELECT
            COUNT(*)::int AS total_count,
            COALESCE(SUM(actual_total), 0)::text AS total,
            COALESCE(SUM(items_total), 0)::text AS items_total,
            COALESCE(SUM(expenses_total), 0)::text AS expenses_total,
            COALESCE(SUM(actual_cash_total), 0)::text AS cash,
            COALESCE(SUM(actual_transfer_total), 0)::text AS transfer
          FROM filtered
        `),
        );
        const summary = summaryRows[0] ?? {
          total_count: 0,
          total: '0',
          items_total: '0',
          expenses_total: '0',
          cash: '0',
          transfer: '0',
        };

        type PageDbRow = {
          id: string;
          run_date: string;
          run_index: number;
          status: string;
          finished_at: Date | string | null;
          actual_total: string;
          items_total: string;
          expenses_total: string;
          actual_cash_total: string;
          actual_transfer_total: string;
          item_count: number;
          store_count: number;
        };
        const directionSql =
          query.sort === 'oldest'
            ? sql`run_date ASC, run_index ASC, id ASC`
            : sql`run_date DESC, run_index DESC, id DESC`;
        // DX-HIS-5 (2026-11-01): the list shows one row per day, so a page
        // never splits a day. A day belongs to the page where its first
        // run falls (pages of `pageSize` runs); a page holding no day start
        // (one day longer than a page) is skipped, so pages stay dense.
        // Before, the second trip of a day could open the next page with
        // half the day's total on each.
        const pagedCte = sql`
          ${historyCte},
          ordered AS (
            SELECT f.*, (ROW_NUMBER() OVER (ORDER BY ${directionSql}) - 1)::int AS pos
            FROM filtered f
          ),
          day_started AS (
            SELECT o.*, MIN(o.pos) OVER (PARTITION BY o.run_date)::int AS day_pos
            FROM ordered o
          ),
          paged AS (
            SELECT d.*, DENSE_RANK() OVER (ORDER BY d.day_pos / ${query.pageSize}::int)::int AS page_no
            FROM day_started d
          )
        `;
        const pageCountRows = executeRows<{ pages: number }>(
          await tx.execute(sql`
          ${pagedCte}
          SELECT COALESCE(MAX(page_no), 0)::int AS pages FROM paged
        `),
        );
        const totalPages = Number(pageCountRows[0]?.pages ?? 0);
        const pageRows = executeRows<PageDbRow & { pos: number }>(
          await tx.execute(sql`
          ${pagedCte}
          SELECT
            pos,
            id::text AS id,
            run_date::text AS run_date,
            run_index,
            status,
            finished_at,
            actual_total::text AS actual_total,
            items_total::text AS items_total,
            expenses_total::text AS expenses_total,
            actual_cash_total::text AS actual_cash_total,
            actual_transfer_total::text AS actual_transfer_total,
            item_count,
            store_count
          FROM paged
          WHERE page_no = ${query.page}
          ORDER BY pos
        `),
        );

        type StoreTotalDbRow = {
          run_id: string;
          store_id: string;
          total: string;
          items_total: string;
          expenses_total: string;
          cash: string;
          transfer: string;
          item_count: number;
        };
        const storeTotalsByRun = new Map<
          string,
          Array<{
            storeId: string;
            total: string;
            itemsTotal: string;
            expensesTotal: string;
            cash: string;
            transfer: string;
            itemCount: number;
          }>
        >();
        const pageRunIds = pageRows.map((row) => row.id);
        if (pageRunIds.length > 0) {
          const runIdsSql = sql.join(
            pageRunIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          );
          const storeTotalRows = executeRows<StoreTotalDbRow>(
            await tx.execute(sql`
            WITH money_lines AS (
              ${runMoneyLinesSql({
                runsSql: sql`(SELECT unnest(ARRAY[${runIdsSql}]::uuid[]) AS id)`,
                storeIdsSql,
              })}
            )
            SELECT
              run_id::text AS run_id,
              store_id::text AS store_id,
              COALESCE(SUM(amount), 0)::text AS total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'item'), 0)::text AS items_total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::text AS expenses_total,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0)::text AS cash,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'transfer'), 0)::text AS transfer,
              (COUNT(DISTINCT sku_id) FILTER (WHERE sku_id IS NOT NULL))::int AS item_count
            FROM money_lines
            GROUP BY run_id, store_id
            ORDER BY run_id, SUM(amount) DESC, store_id
          `),
          );
          for (const row of storeTotalRows) {
            const totals = storeTotalsByRun.get(row.run_id) ?? [];
            totals.push({
              storeId: row.store_id,
              total: moneyText(row.total),
              itemsTotal: moneyText(row.items_total),
              expensesTotal: moneyText(row.expenses_total),
              cash: moneyText(row.cash),
              transfer: moneyText(row.transfer),
              itemCount: row.item_count,
            });
            storeTotalsByRun.set(row.run_id, totals);
          }
        }

        const totalCount = Number(summary.total_count ?? 0);
        return {
          rows: pageRows.map((row) => ({
            id: row.id,
            runDate: row.run_date,
            runIndex: row.run_index,
            status: row.status,
            // 2026-10-21 CA-11: actualTotal = itemsTotal + expensesTotal
            // over the reader's visible stores (unchanged meaning here —
            // history always included expenses).
            actualTotal: moneyText(row.actual_total),
            itemsTotal: moneyText(row.items_total),
            expensesTotal: moneyText(row.expenses_total),
            actualCashTotal: moneyText(row.actual_cash_total),
            actualTransferTotal: moneyText(row.actual_transfer_total),
            finishedAt: row.finished_at,
            itemCount: row.item_count,
            storeCount: row.store_count,
            storeTotals: storeTotalsByRun.get(row.id) ?? [],
          })),
          pageInfo: {
            page: query.page,
            pageSize: query.pageSize,
            totalCount,
            totalPages,
            hasPrevious: query.page > 1,
            hasNext: query.page < totalPages,
            /** 1-based positions of this page's first and last run (a page
             *  holds whole days, so it is not always `pageSize` runs). */
            firstRun: pageRows.length > 0 ? pageRows[0]!.pos + 1 : 0,
            lastRun: pageRows.length > 0 ? pageRows[pageRows.length - 1]!.pos + 1 : 0,
          },
          summary: {
            total: moneyText(summary.total),
            itemsTotal: moneyText(summary.items_total),
            expensesTotal: moneyText(summary.expenses_total),
            cash: moneyText(summary.cash),
            transfer: moneyText(summary.transfer),
          },
        };
      },
      {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      },
    ),
  ),

  /**
   * Read-only detail payload for History. Unlike `run.get` (the live
   * purchaser workspace), this endpoint requires financial visibility and
   * physically removes every store branch outside that permission scope.
   */
  historyDetail: authedProcedure
    .input(SimpleRunCommandSchema.pick({ runId: true }))
    .query(async ({ ctx, input }) =>
      ctx.withOrg(async (tx) => {
        const allowedStoreIds = await getActorStoreIdsForPermission(
          tx,
          ctx.session!.memberId,
          'prices.view',
          ctx.session!.permissions,
        );
        if (allowedStoreIds !== null && allowedStoreIds.length === 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.missingPermission',
            cause: { missingPermission: 'prices.view' },
          });
        }

        const run = await loadRun(tx, ctx.session!.orgId, input.runId);
        // D5 (2026-10-31): a run reopened for amending stays in History
        // (labelled 修改中) — finance counts it too.
        if (run.status !== 'finished' && run.status !== 'amending') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
        }
        // Already reopened: nothing more to reopen from here.
        const canAmend = run.status === 'finished' && (await canAmendRun(tx, ctx, run));
        const allowedStoreSet = allowedStoreIds === null ? null : new Set(allowedStoreIds);
        const { sessions: visibleSessions, items: sessionItems } = await loadRunSessions(
          tx,
          run.sessionIdsJson,
          allowedStoreSet,
        );
        if (allowedStoreSet && visibleSessions.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
        }
        const allItems = await tx.query.runItemsV.findMany({
          where: (item, { eq: eq2 }) => eq2(item.runId, run.id),
          orderBy: (item, { asc }) => asc(item.skuId),
        });
        const allSplits = await tx.query.runItemStoresV.findMany({
          where: (split, { eq: eq2 }) => eq2(split.runId, run.id),
          orderBy: (split, { asc }) => [asc(split.skuId), asc(split.storeId)],
        });
        const { splits, hiddenSkuIds } = splitsForReader(allItems, allSplits, allowedStoreSet);
        const { sessions, perStoreDemand, sessionNotesByStore, sessionExtrasByStore } =
          await runSessionsView(tx, visibleSessions, sessionItems);
        // Never the organisation's quantities, prices or receipts for a
        // store-scoped history reader.
        const items =
          allowedStoreSet === null
            ? allItems
            : itemsForStoreReader(allItems, splits, perStoreDemand, hiddenSkuIds);

        const rawExpenses = await tx.query.runExpensesV.findMany({
          where: (expense, { and: and2, eq: eq2, isNull }) =>
            and2(eq2(expense.runId, run.id), isNull(expense.removedAt)),
          orderBy: (expense, { asc }) => asc(expense.addedAt),
        });
        const expenses = expensesForReader(rawExpenses, allowedStoreSet);

        // DX-HIS-6 (2026-11-01): the detail names each line's supplier.
        // Names come with the payload: catalog.suppliers is not readable
        // by every history reader (a store manager).
        const supplierIds = [
          ...new Set(items.map((item) => item.supplierId).filter((id): id is string => !!id)),
        ];
        const supplierNameById: Record<string, string> = {};
        if (supplierIds.length > 0) {
          const rows = await tx
            .select({ id: s.suppliers.id, name: s.suppliers.name })
            .from(s.suppliers)
            .where(and(eq(s.suppliers.orgId, ctx.session!.orgId), inArray(s.suppliers.id, supplierIds)));
          for (const row of rows) supplierNameById[row.id] = row.name;
        }

        // Review RUNWEB2-03 (2026-11): the money, from the lines the History
        // list row and report.* add up, in the stores this reader may see
        // prices in. The page recomputed it with its own copy of the rule.
        const moneyLines = executeRows<RunMoneyLine>(
          await tx.execute(sql`
            SELECT
              store_id::text AS "storeId",
              kind,
              sku_id::text AS "skuId",
              expense_id::text AS "expenseId",
              amount::text AS amount,
              payment_method AS "paymentMethod"
            FROM (
              ${runMoneyLinesSql({
                runsSql: sql`(SELECT ${run.id}::uuid AS id)`,
                storeIdsSql: uuidListSql(allowedStoreIds),
              })}
            ) money_lines
          `),
        );
        const { byStore, bySku, bySplit, byExpense, ...runTotals } = runDetailMoney(moneyLines);

        return {
          id: run.id,
          runDate: run.runDate,
          runIndex: run.runIndex,
          status: run.status,
          finishedAt: run.finishedAt,
          items: items.map((item) => {
            const money = bySku.get(item.skuId);
            return {
              ...item,
              /** What it cost in the visible stores; null when nothing was bought. */
              amount: money?.total ?? null,
              cashAmount: money?.cash ?? null,
              transferAmount: money?.transfer ?? null,
            };
          }),
          splits: splits.map((split) => ({
            ...split,
            amount: bySplit.get(`${split.skuId}|${split.storeId}`)?.total ?? null,
          })),
          perStoreDemand,
          sessionNotesByStore,
          sessionExtrasByStore,
          sessions,
          expenses: expenses.map((expense) => ({
            ...expense,
            /** Its share in the visible stores. */
            amount: byExpense.get(expense.id)?.total ?? null,
          })),
          money: { ...runTotals, byStore },
          supplierNameById,
          canAmend,
          // D3 / D4 (2026-10-31): quantity added in a correction and price
          // changes after receipt, for the history labels.
          corrections: runCorrections(await readRunEvents(tx, run.id), allowedStoreSet),
        };
      }),
    ),

  get: runReadProcedure
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
        const allowedStoreIds = await resolveRunReadStoreScope(tx, ctx);
        const allowedStoreSet = allowedStoreIds === null ? null : new Set(allowedStoreIds);
        if (allowedStoreSet) {
          const involvedStoreIds = await runInvolvedStoreIds(tx, run);
          if (!involvedStoreIds.some((storeId) => allowedStoreSet.has(storeId))) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'run.errors.notVisible',
            });
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
        const allItems = await tx.query.runItemsV.findMany({
          where: (i, { eq: eq2 }) => eq2(i.runId, run.id),
          orderBy: (i, { asc }) => asc(i.skuId),
        });
        type VisibleRunItem = Omit<(typeof allItems)[number], 'paymentMethod'> & {
          paymentMethod: string | null;
          /** BUY-5: demand that joined after the item was decided. */
          topUpQty?: string | null;
        };
        const allSplits = await tx.query.runItemStoresV.findMany({
          where: (i, { eq: eq2 }) => eq2(i.runId, run.id),
          orderBy: (i, { asc }) => [asc(i.skuId), asc(i.storeId)],
        });
        const itemBySkuId = new Map(allItems.map((item) => [item.skuId, item]));
        const { splits, hiddenSkuIds } = splitsForReader(allItems, allSplits, allowedStoreSet);

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
        // M1.8 / M3.16-C / M3.37: each store's session notes and extras
        // come with it, so the purchaser sees the staff's "其他物品"
        // next to that store's demand and can mark each extra.
        const { sessions: visibleSessions, items: sessionItems } = await loadRunSessions(
          tx,
          run.sessionIdsJson,
          allowedStoreSet,
        );
        const visibleSessionIds = visibleSessions.map((session) => session.id);
        const {
          sessions: runSessions,
          perStoreDemand,
          sessionNotesByStore,
          sessionExtrasByStore,
        } = await runSessionsView(tx, visibleSessions, sessionItems);

        let items: VisibleRunItem[] =
          allowedStoreSet === null
            ? allItems
            : itemsForStoreReader(allItems, splits, perStoreDemand, hiddenSkuIds);

        const recalledStoreIds: string[] = [];
        // BUY-5 (2026-10-30): "still need X" lives in the domain state only
        // (no read-model column); a run stream is a few dozen events.
        {
          const events = await readRunEvents(tx, run.id);
          const domainState = replayRun(run.id, events);
          items = items.map((it) => ({
            ...it,
            topUpQty: domainState.items.get(it.skuId)?.topUpQty ?? null,
          }));
          // DX-DLV-13 (2026-11-01): a store whose delivery was recalled
          // and not made again. Its receiving page said "nothing to
          // receive", as if the goods had never been on the way.
          const lastDeliveryEvent = new Map<string, string>();
          for (const e of events) {
            if (e.type === 'StoreDelivered' || e.type === 'StoreDeliveryUndone') {
              lastDeliveryEvent.set(e.payload.storeId, e.type);
            }
          }
          for (const [storeId, type] of lastDeliveryEvent) {
            if (type !== 'StoreDeliveryUndone') continue;
            if (allowedStoreSet && !allowedStoreSet.has(storeId)) continue;
            recalledStoreIds.push(storeId);
          }
        }

        // M3.27 (2026-05-18): preferred-supplier mapping for the
        // active-run "by vendor" view. Mirrors previewCreatable's
        // logic verbatim (preview/active should always agree on which
        // stall an item is routed to). Only one DISTINCT ON query
        // for all SKUs in the run.
        const runSkuIds = items.map((it) => it.skuId);
        const supplierBySku: Record<
          string,
          {
            id: string;
            name: string;
            contactPhone: string | null;
            contactTg: string | null;
          } | null
        > = {};
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
          for (const r of executeRows<(typeof rows)[number]>(rows)) {
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
          const visiblePriceStoreIds = [
            ...new Set([
              ...perStoreDemand.map((row) => row.storeId),
              ...splits.map((row) => row.storeId),
            ]),
          ];
          // An ordinary purchase (no per-store price) records ONE
          // price_history row with no store_id; only split overrides
          // record a row per store. Filtering on store_id alone therefore
          // hid every past price from a store-scoped purchaser (the
          // built-in purchaser role): no carried-over price, no one-tap
          // buy, no 5x check. A store-less row counts when that purchase
          // was split to one of the reader's stores.
          const visibleStoreList = sql.join(
            visiblePriceStoreIds.map((storeId) => sql`${storeId}::uuid`),
            sql`, `,
          );
          const priceStoreScope =
            allowedStoreSet === null
              ? sql``
              : sql`AND (
                  store_id IN (${visibleStoreList})
                  OR (
                    store_id IS NULL
                    AND EXISTS (
                      SELECT 1 FROM read_model.run_item_stores_v ris
                      WHERE ris.run_id = price_history.run_id
                        AND ris.sku_id = price_history.sku_id
                        AND ris.store_id IN (${visibleStoreList})
                    )
                  )
                )`;
          const rows = (await tx.execute(
            sql`SELECT DISTINCT ON (sku_id) sku_id::text AS sku_id,
                       unit_price::text AS unit_price,
                       observed_at
                FROM inventory.price_history
                WHERE org_id = ${ctx.session!.orgId}
                  AND superseded_at IS NULL
                  ${priceStoreScope}
                  AND sku_id IN ${inUuids(skuIds)}
                  -- 2026-07-27: exclude THIS run's own observations.
                  --
                  -- Every ItemPurchased inserts a price_history row
                  -- (runProjection.ts:88/138/465). Without this filter the
                  -- "last observed price" for an item the purchaser just
                  -- saved IS the price they just saved — so the reference
                  -- chases the entry and can never disagree with it.
                  --
                  -- Two things broke on that, both proven empirically:
                  --   * the finish sheet's "N priced the same as last
                  --     time" counted EVERY purchased row, including one
                  --     retyped from 70,000 to 105,000, because by then
                  --     both sides of the comparison read 105,000;
                  --   * observed_at became today for every saved row, so
                  --     isStalePrice was permanently false and the
                  --     stale-reference warning could never fire once.
                  --
                  -- That counter is the whole safety argument for hiding
                  -- the price editor behind a tap (Q7b), so it has to
                  -- compare against the PREVIOUS trip, not this one.
                  --
                  -- IS DISTINCT FROM, not <>: run_id is nullable, and
                  -- NULL <> $1 evaluates to NULL, which would silently
                  -- drop every historical observation that predates run
                  -- tracking.
                  AND run_id IS DISTINCT FROM ${run.id}
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
        const rawExpenses = await tx.query.runExpensesV.findMany({
          where: (e, { eq: eq2, and: and2, isNull }) =>
            and2(eq2(e.runId, run.id), isNull(e.removedAt)),
          orderBy: (e, { asc }) => asc(e.addedAt),
        });
        const expenses = expensesForReader(rawExpenses, allowedStoreSet);

        const visibleMoney = {
          total: [] as string[],
          cash: [] as string[],
          transfer: [] as string[],
        };
        if (allowedStoreSet) {
          for (const split of splits) {
            const item = itemBySkuId.get(split.skuId);
            if (item?.status !== 'purchased' || split.unitPrice === null) continue;
            const subtotal = lineAmount(split.qty, split.unitPrice);
            visibleMoney.total.push(subtotal);
            if (split.paymentMethod === 'transfer') visibleMoney.transfer.push(subtotal);
            else visibleMoney.cash.push(subtotal);
          }
        }

        // 2026-10-21 CA-11: the one purchase-money definition (see
        // services/runMoney.ts), live and exact, over the visible stores:
        // items at COALESCE(split override, item price) + active expenses.
        // The finish / refinalize sheets show exactly these three numbers.
        const moneyItemParts: string[] = [];
        for (const split of splits) {
          const item = itemBySkuId.get(split.skuId);
          if (item?.status !== 'purchased') continue;
          const price = split.unitPrice ?? item.unitPrice;
          if (!price) continue;
          moneyItemParts.push(lineAmount(split.qty, price));
        }
        // D1: each line rounded half-up to cents, summed in cents — the
        // same figures as report.* and the frozen RunFinished totals.
        const moneyExpenseParts = expenses.flatMap((expense) =>
          expense.storeSplits.map((split) => lineAmount(split.qty, expense.unitPrice)),
        );
        const moneyItemsTotal = sumMoney(moneyItemParts);
        const moneyExpensesTotal = sumMoney(moneyExpenseParts);
        const money = {
          itemsTotal: moneyItemsTotal,
          expensesTotal: moneyExpensesTotal,
          total: sumMoney([moneyItemsTotal, moneyExpensesTotal]),
        };

        // DLV-14 (2026-10-30): a store-scoped deny on delivery.dispatch only
        // showed up as an error after tapping that store's row. Name those
        // stores so the row can say so up front. Only while delivering, and
        // only for an actor who can dispatch at all.
        const dispatchDeniedStoreIds: string[] = [];
        if (run.status === 'delivering' && ctx.session!.permissions.has('delivery.dispatch')) {
          for (const storeId of await runInvolvedStoreIds(tx, run)) {
            if (allowedStoreSet && !allowedStoreSet.has(storeId)) continue;
            const perms = await effectivePermissionsForStore(
              tx,
              ctx.session!.memberId,
              storeId,
              ctx.session!.permissions,
            );
            if (!perms.has('delivery.dispatch')) dispatchDeniedStoreIds.push(storeId);
          }
        }

        // RE-DLV-3 (2026-10-31): whether this actor may finish (or close
        // the correction of) the run, so the screen can say why up front
        // instead of answering 403 after the summary sheet.
        const finishBlockedReason = await finishBlockedReasonFor(tx, ctx, run);

        // BUY-6 (2026-10-30): the stores this actor purchases for (null =
        // all), so rows serving other stores can be shown read-only.
        const purchaseScopeStoreIds = await getActorStoreIdsForPermission(
          tx,
          ctx.session!.memberId,
          'run.purchase',
          ctx.session!.permissions,
        );
        // Items that also serve a store outside that scope — from all of
        // the run's demand and splits, not the redacted view above.
        const otherStoreSkuIds: string[] = [];
        if (purchaseScopeStoreIds !== null) {
          const scope = new Set(purchaseScopeStoreIds);
          const runSessionIds = run.sessionIdsJson;
          const demandRows =
            runSessionIds.length > 0
              ? await tx
                  .selectDistinct({
                    skuId: s.orderItemsV.skuId,
                    storeId: s.orderSessionsV.storeId,
                  })
                  .from(s.orderItemsV)
                  .innerJoin(s.orderSessionsV, eq(s.orderSessionsV.id, s.orderItemsV.sessionId))
                  .where(
                    and(
                      inArray(s.orderItemsV.sessionId, runSessionIds),
                      sql`${s.orderItemsV.qty} > 0`,
                    ),
                  )
              : [];
          const other = new Set<string>();
          for (const row of [...demandRows, ...allSplits]) {
            if (!scope.has(row.storeId)) other.add(row.skuId);
          }
          otherStoreSkuIds.push(...other);
        }
        // D9 (2026-10-31): expenses split to a store outside that scope are
        // not this purchaser's to remove (run.get shows them only their
        // own share, so the screen cannot tell otherwise).
        const otherStoreExpenseIds =
          purchaseScopeStoreIds === null
            ? []
            : rawExpenses
                .filter((expense) =>
                  (expense.storeSplitsJson as Array<{ storeId: string }>).some(
                    (split) => !purchaseScopeStoreIds.includes(split.storeId),
                  ),
                )
                .map((expense) => expense.id);

        const payload = {
          ...run,
          money,
          purchaseScopeStoreIds,
          otherStoreSkuIds,
          otherStoreExpenseIds,
          dispatchDeniedStoreIds,
          finishBlockedReason,
          ...(allowedStoreSet
            ? {
                plannedTotal: null,
                actualTotal:
                  run.actualTotal === null ? null : sumMoney(visibleMoney.total),
                actualCashTotal:
                  run.actualCashTotal === null ? null : sumMoney(visibleMoney.cash),
                actualTransferTotal:
                  run.actualTransferTotal === null
                    ? null
                    : sumMoney(visibleMoney.transfer),
                sessionIdsJson: visibleSessionIds,
              }
            : {}),
          items,
          // DX-BUY-1: a split paid like its item reads as "same as the item",
          // so the row's 现金 / 转账 switch works for a store-scoped buyer.
          splits: allowedStoreSet ? splitsInheritingItemPayment(items, splits) : splits,
          perStoreDemand,
          lastPriceBySku,
          lastPriceObservedAtBySku,
          sessionNotesByStore,
          sessionExtrasByStore,
          supplierBySku,
          sessions: runSessions,
          recalledStoreIds,
          // M3.44: off-catalog expenses (purchaser-recorded). FE
          // renders these in an "Off-catalog / Expenses" card and
          // sums them into the finish-summary breakdown.
          expenses,
          // C.2: claim display fields. The raw memberId columns are
          // already in `...run` (drizzle spreads the row); these are
          // the resolved names for the banner.
          claimedByDisplayName,
          previousClaimerDisplayName,
          claimedAt: run.claimedAt?.toISOString() ?? null,
        };
        // D6 (2026-10-31): prices only when prices.view holds in every
        // store this reader is shown (a staff member at A who manages B
        // reads a run serving both without money).
        const shownStoreIds = new Set<string>([
          ...splits.map((split) => split.storeId),
          ...perStoreDemand.map((demand) => demand.storeId),
          ...runSessions.map((sess) => sess.storeId),
          ...expenses.flatMap((expense) => expense.storeSplits.map((split) => split.storeId)),
        ]);
        const priceStores = await priceStoreIds(tx, ctx.session!);
        return pricesVisibleFor(priceStores, shownStoreIds) ? payload : withoutPrices(payload);
      });
    }),

  /**
   * C.2 (M3.38, 2026-05-19): claim a run so other purchasers can't
   * mutate it concurrently. Mirrors `order.claim`. The FE calls this
   * on RunPage mount when status ∈ {purchasing, delivering}. The
   * domain layer's `assertClaimOwnership` is what actually enforces
   * the lock; this endpoint just announces "I'm taking it".
   *
   * @deprecated BUY-20 (2026-10-30): the web app stopped calling it in
   * UIUX-B1 and Fine never did; logged when called so it can be removed.
   */
  claim: authedProcedure
    .input(SimpleRunCommandSchema)
    .mutation(async ({ ctx, input }) => {
      logger.warn({ procedure: 'run.claim', orgId: ctx.session?.orgId }, 'deprecated procedure called');
      return runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, { type: 'ClaimRun', actor: actorFromCtx(ctx) }),
      );
    }),

  /**
   * C.2 (M3.38, 2026-05-19): release a run claim. Reason 'manual' for
   * the explicit Release button; 'pagehide' for the FE's
   * visibilitychange auto-release. Override path: when the caller is
   * NOT the current claimer, the domain layer re-tags the emitted
   * event with reason 'override' (the take-over button uses this).
   *
   * @deprecated BUY-20 (2026-10-30): no client calls it; see `claim`.
   */
  releaseClaim: authedProcedure
    .input(
      SimpleRunCommandSchema.extend({
        reason: z.enum(['manual', 'pagehide']).default('manual'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      logger.warn(
        { procedure: 'run.releaseClaim', orgId: ctx.session?.orgId },
        'deprecated procedure called',
      );
      return runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'ReleaseRunClaim',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      );
    }),

  startPurchase: authedProcedure
    .input(SimpleRunCommandSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, { type: 'StartPurchase', actor: actorFromCtx(ctx) }),
      ),
    ),

  // M1.20: idempotent — record-purchase replays would double-deduct
  // inventory + double-record price history.
  purchaseItem: idempotentMutation.input(PurchaseItemInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, scope) =>
        decideRun(state, {
          type: 'PurchaseItem',
          skuId: input.skuId,
          supplierId: input.supplierId,
          unitPrice: input.unitPrice,
          actualQty: input.actualQty,
          receiptPhotoUrl: input.receiptPhotoUrl,
          storeSplits: input.storeSplits,
          paymentMethod: input.paymentMethod,
          priceConfirmed: input.priceConfirmed,
          ...scope,
          actor: actorFromCtx(ctx),
        }),
      {
        withRunStoreIds: true,
        item: {
          skuId: input.skuId,
          splitStoreIds: (input.storeSplits ?? []).map((split) => split.storeId),
        },
      },
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
      runSimpleCommand(
        ctx,
        input.runId,
        (state, scope) =>
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
            priceConfirmed: input.priceConfirmed,
            ...scope,
            actor: actorFromCtx(ctx),
          }),
        {
          withRunStoreIds: true,
          item: {
            skuId: input.skuId,
            splitStoreIds: input.storeSplits.map((split) => split.storeId),
          },
        },
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
  addExpense: idempotentMutation.input(AddRunExpenseInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, scope) =>
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
          ...scope,
          actor: actorFromCtx(ctx),
        }),
      {
        withRunStoreIds: true,
        expense: {
          expenseId: input.expenseId,
          splitStoreIds: input.storeSplits.map((split) => split.storeId),
        },
      },
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
      runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'RemoveRunExpense',
            expenseId: input.expenseId,
            reason: input.reason,
            actor: actorFromCtx(ctx),
          }),
        { expense: { expenseId: input.expenseId } },
      ),
    ),

  // BUY-9 (2026-10-30): idempotent, so an offline replay of a request
  // that already landed (lost response) is answered, not refused.
  markUnavailable: idempotentMutation
    .input(MarkUnavailableInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'MarkUnavailable',
          skuId: input.skuId,
          note: input.note,
          actor: actorFromCtx(ctx),
        }),
        { item: { skuId: input.skuId } },
      ),
    ),

  startDelivery: authedProcedure
    .input(SimpleRunCommandSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, { type: 'StartDelivery', actor: actorFromCtx(ctx) }),
      ),
    ),

  deliverToStore: idempotentMutation.input(DispatchInputSchema).mutation(async ({ ctx, input }) => {
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
    return runSimpleCommand(
      ctx,
      input.runId,
      (state, scope) =>
        decideRun(state, {
          type: 'DeliverToStore',
          storeId: input.storeId,
          ...scope,
          actor: actorFromCtx(ctx, effectivePerms),
        }),
      { skipRunPermissionScope: true, withRunStoreIds: true },
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
      return runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'ConfirmStoreItem',
            storeId: input.storeId,
            skuId: input.skuId,
            status: input.status,
            note: input.note,
            photoUrl: input.photoUrl,
            receivedQty: input.receivedQty ?? null,
            actor: actorFromCtx(ctx, effectivePerms),
          }),
        { skipRunPermissionScope: true },
      );
    }),

  /**
   * Bulk receiver action: mark every undecided line at one store as OK.
   * One transaction, one projection pass and one notification dispatch.
   * Individual `StoreItemConfirmed` events remain in the audit stream.
   */
  markStoreItemsOk: authedProcedure
    .input(MarkStoreItemsOkInputSchema)
    .mutation(async ({ ctx, input }) => {
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
      const skuIds = [...new Set(input.skuIds)];
      const result = await runSimpleCommand(
        ctx,
        input.runId,
        (state) => {
          // 2026-10-21 audit CA-30: same receipt-phase guard as the
          // domain's ConfirmStoreItem, checked up front so a request whose
          // SKUs are all already decided still fails before delivery /
          // after the store has signed.
          const target = state.stores.get(input.storeId);
          if (!target?.deliveredAt) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'run.errors.storeNotDelivered',
            });
          }
          if (target.confirmedAt) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'run.errors.storeAlreadyConfirmed',
            });
          }
          const expected = new Set<string>();
          for (const item of state.items.values()) {
            if (item.status !== 'purchased') continue;
            for (const split of item.storeSplits) {
              if (split.storeId === input.storeId) expected.add(item.skuId);
            }
          }

          let current = state;
          const events: RunEvent[] = [];
          for (const skuId of skuIds) {
            if (!expected.has(skuId)) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'run.errors.itemNotInRun',
              });
            }
            if (current.stores.get(input.storeId)?.itemConfirms.has(skuId)) continue;
            const out = decideRun(current, {
              type: 'ConfirmStoreItem',
              storeId: input.storeId,
              skuId,
              status: 'ok',
              note: null,
              photoUrl: null,
              actor: actorFromCtx(ctx, effectivePerms),
            });
            events.push(...out);
            current = out.reduce(applyRun, current);
          }
          return events;
        },
        { skipRunPermissionScope: true },
      );
      return { marked: result.eventCount, lastSeq: result.lastSeq };
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
    return runSimpleCommand(
      ctx,
      input.runId,
      (state) =>
        decideRun(state, {
          type: 'ConfirmStore',
          storeId: input.storeId,
          actor: actorFromCtx(ctx, effectivePerms),
        }),
      { skipRunPermissionScope: true },
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
   *   Every session the domain refuses to archive goes into
   *   `archiveFailures`; if the list is non-empty after the loop we
   *   throw, which rolls back BOTH the RunFinished event AND any
   *   partial session archives. The operator gets a structured error
   *   with the full failure list and retries after fixing the cause.
   *   A database error ends the transaction at once (RUNAPI-09): a
   *   sequence race is decided again by withRunStreamRetry.
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
    return withRunStreamRetry(ctx, async (tx) => {
      const run = await loadRun(tx, ctx.session!.orgId, input.runId);
      let runState = await loadRunState(tx, run.id);

      // Step 1 — RunFinished on the run stream.
      if (runState.status === 'amending') {
        await assertCanAmendRun(tx, ctx, run);
      } else {
        await assertRunPermissionForAllStores(tx, ctx, run, 'run.finish');
      }

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
        runState = await writeRunEvents(tx, ctx.session!.orgId, runState, finishEvents);
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
        const oState = await loadOrderState(tx, sessionId);
        if (oState.status === 'archived') continue; // already archived → no-op

        let ev: OrderEvent[] = [];
        try {
          ev = decideOrder(oState, {
            type: 'Archive',
            reason: 'run_finished',
            actor: orderActorFromCtx(ctx, oState),
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
        // RUNAPI-09 (2026-11-09): a database error here is not collected.
        // It aborts the transaction, so the next session's read failed
        // anyway, and a sequence race (someone marking an extra at that
        // moment) answered 500 instead of being decided again. It goes
        // out as it is: withRunStreamRetry runs the whole finish again
        // on the fresh streams, and anything else rolls it back.
        await writeOrderEvents(tx, ctx.session!.orgId, sessionId, ev);
      }

      // M3.4 atomicity bar — if the domain refused any session, abort
      // the whole tx by throwing. ctx.withOrg's transaction roll-back
      // undoes the Step-1 RunFinished event AND the archives written in
      // this loop before it.
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
      return {
        lastSeq: runState.seq,
        archiveFailures: [] as Array<{ sessionId: string; reason: string }>,
      };
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
      runSimpleCommand(
        ctx,
        input.runId,
        (state, { readStoreIds = null, ...scope }) => {
          // 2026-10-21: a store-scoped reader only ever saw part of this
          // item (run.get redaction); keep the hidden stores' splits,
          // quantity, prices, supplier and receipt instead of letting the
          // wholesale replacement below erase them.
          const item = state.items.get(input.skuId);
          let revision = input;
          if (item) {
            try {
              revision = mergeScopedRevision(item, input, readStoreIds);
            } catch (err) {
              if (err instanceof StoreOutOfScopeError) {
                throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.notVisible' });
              }
              throw err;
            }
          }
          return decideRun(state, {
            type: 'RevisePurchase',
            skuId: revision.skuId,
            supplierId: revision.supplierId,
            unitPrice: revision.unitPrice,
            actualQty: revision.actualQty,
            receiptPhotoUrl: revision.receiptPhotoUrl,
            storeSplits: revision.storeSplits,
            reason: revision.reason,
            paymentMethod: revision.paymentMethod,
            priceConfirmed: revision.priceConfirmed,
            ...scope,
            actor: actorFromCtx(ctx),
          });
        },
        {
          withRunStoreIds: true,
          withReadScope: true,
          item: {
            skuId: input.skuId,
            splitStoreIds: input.storeSplits.map((split) => split.storeId),
          },
        },
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
        { item: { skuId: input.skuId } },
      ),
    ),

  /** BUY-5 (2026-10-30): the extra demand that joined after this item was
   *  bought or marked unavailable will not be bought. */
  dismissTopUp: authedProcedure
    .input(DismissTopUpInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'DismissTopUp',
          skuId: input.skuId,
          note: input.note,
          actor: actorFromCtx(ctx),
        }),
        { item: { skuId: input.skuId } },
      ),
    ),

  /** Revert a purchased item back to pending (mistapped row, decided
   *  not to buy after all). Blocked once any destination store has
   *  accepted delivery. */
  undoPurchase: authedProcedure.input(UndoPurchaseInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, { readStoreIds = null }) => {
        // 2026-10-21: undo erases every store's split; refuse it for an
        // actor who can't see all of them (see mergeScopedRevision).
        const item = state.items.get(input.skuId);
        if (item && hiddenSplits(item, readStoreIds).length > 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.notVisible' });
        }
        return decideRun(state, {
          type: 'UndoPurchase',
          skuId: input.skuId,
          reason: input.reason,
          actor: actorFromCtx(ctx),
        });
      },
      { withReadScope: true, item: { skuId: input.skuId } },
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
  reopen: authedProcedure.input(RunReasonOnlyInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state) =>
        decideRun(state, {
          type: 'ReopenRun',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      { requireGlobalAmend: true },
    ),
  ),

  /**
   * Correct the calendar date a run's spend is booked under.
   *
   * Deliberately NOT wrapped in reopen → change → refinalize: this
   * touches no money, and refinalize would rewrite the run's frozen
   * totals as a side effect of a pure date fix. Works on finished runs
   * directly; the domain rejects only `cancelled`.
   */
  changeDate: authedProcedure.input(ChangeRunDateInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, { nextRunIndex }) => {
        // HIS-7 (2026-10-30): the same rule as creating a run — never a
        // day that has not come yet in the org's time zone. Checked after
        // the amend gate so a caller without it hears about that first.
        if (input.runDate > todayStr(ctx)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'run.errors.runDateInFuture' });
        }
        return decideRun(state, {
          type: 'ChangeRunDate',
          runDate: input.runDate,
          runIndex: nextRunIndex,
          actor: actorFromCtx(ctx),
        });
      },
      // 2026-10-23: runs are numbered per day (unique org + date + index);
      // moving a run onto a day that already has a run #0 hit that index
      // and surfaced as "edited by someone else". It now becomes that
      // day's next run.
      { requireGlobalAmend: true, nextRunIndexOn: input.runDate },
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
      return runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'UndeliverStore',
            storeId: input.storeId,
            reason: input.reason,
            actor: actorFromCtx(ctx, effectivePerms),
          }),
        { skipRunPermissionScope: true },
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
      runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'UndoStartDelivery',
            reason: input.reason,
            actor: actorFromCtx(ctx),
          }),
        { requiredPermission: 'delivery.dispatch' },
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
    return withRunStreamRetry(ctx, async (tx) => {
      const run = await loadRun(tx, ctx.session!.orgId, input.runId);
      let runState = await loadRunState(tx, run.id);

      // Step 1 — produce RunCancelled. Domain validates permission +
      // status guards (e.g. not already finished).
      if (runState.status === 'amending') {
        await assertCanAmendRun(tx, ctx, run);
      } else {
        await assertRunPermissionForAllStores(tx, ctx, run, 'run.create');
      }

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
        runState = await writeRunEvents(tx, ctx.session!.orgId, runState, cancelEvents);
        // 2026-10-21 audit CA-31: the RunCancelled notification branch
        // existed but was never reached — stores that had just been told
        // "delivery arrived" never learned the run was scrapped.
        await dispatchRunEventNotifications(
          tx,
          ctx.session!.orgId,
          ctx.session!.userId,
          runState,
          cancelEvents,
        );
      }

      // Step 2 — eject every attached session. Sessions that are still
      // `in_run` get `EjectedFromRun` (status → approved). Sessions that
      // somehow drifted out of `in_run` already (defensive) just no-op.
      const sessionIds = runState.sessionIds;
      const ejectionFailures: Array<{ sessionId: string; reason: string }> = [];
      for (const sessionId of sessionIds) {
        const oState = await loadOrderState(tx, sessionId);

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
        const ejectPerms = new Set([...ctx.session!.permissions, 'run.eject_session']);
        let ev: OrderEvent[] = [];
        try {
          ev = decideOrder(oState, {
            type: 'EjectFromRun',
            runId: run.id,
            reason: input.reason,
            actor: orderActorFromCtx(ctx, oState, ejectPerms),
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
        await writeOrderEvents(tx, ctx.session!.orgId, sessionId, ev);
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
    return withRunStreamRetry(ctx, async (tx) => {
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
      const effectivePerms = await effectivePermissionsForStore(
        tx,
        ctx.session!.memberId,
        session.storeId,
        ctx.session!.permissions,
      );
      if (!effectivePerms.has('run.eject_session')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.missingPermission',
          cause: { missingPermission: 'run.eject_session' },
        });
      }

      let runState = await loadRunState(tx, input.runId);

      // Check no per-session items have been touched yet.
      if (runState.status === 'amending') await assertCanAmendRun(tx, ctx, run);

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

      // RUNAPI-05: in whole thousandths, as in run.create.
      const removedBySku = new Map<string, bigint>();
      for (const item of sessionItems) {
        const qty = qtyMilli(item.qty);
        if (qty <= 0n) continue;
        removedBySku.set(item.skuId, (removedBySku.get(item.skuId) ?? 0n) + qty);
      }
      const removedPlannedItems = [...removedBySku.entries()].map(([skuId, qty]) => ({
        skuId,
        qty: milliQty(qty),
      }));

      try {
        const runRemovalEvents = decideRun(runState, {
          type: 'EjectSession',
          sessionId: input.sessionId,
          removedPlannedItems,
          reason: input.reason,
          actor: actorFromCtx(ctx, effectivePerms),
        });
        if (runRemovalEvents.length > 0) {
          runState = await writeRunEvents(tx, ctx.session!.orgId, runState, runRemovalEvents);
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
      const oState = await loadOrderState(tx, input.sessionId);
      const ev = decideOrder(oState, {
        type: 'EjectFromRun',
        runId: input.runId,
        reason: input.reason,
        actor: orderActorFromCtx(ctx, oState, effectivePerms),
      });
      await writeOrderEvents(tx, ctx.session!.orgId, input.sessionId, ev);
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
  ctx: RequestContext,
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

/** The actor for an order command a run handler sends to one session. */
function orderActorFromCtx(
  ctx: RequestContext,
  session: OrderState,
  permissions?: ReadonlySet<string>,
) {
  return {
    ...actorFromCtx(ctx, permissions),
    isClaimer: session.claimedByMemberId === ctx.session!.memberId,
  };
}

/**
 * AttachToRun on each session's order stream (approved → in_run), for
 * run.create and attachSessions: the orders can no longer be edited or
 * unapproved. Returns each session's last seq for its order.changed push.
 */
async function attachSessionsToRun(
  tx: DB,
  ctx: RequestContext,
  runId: string,
  sessionIds: readonly string[],
): Promise<Array<{ sessionId: string; lastSeq: number }>> {
  const attached: Array<{ sessionId: string; lastSeq: number }> = [];
  for (const sessionId of sessionIds) {
    const session = await loadOrderState(tx, sessionId);
    const events = decideOrder(session, {
      type: 'AttachToRun',
      runId,
      actor: orderActorFromCtx(ctx, session),
    });
    await writeOrderEvents(tx, ctx.session!.orgId, sessionId, events);
    attached.push({ sessionId, lastSeq: events[events.length - 1]?.seq ?? session.seq });
  }
  return attached;
}

/**
 * One run-stream transaction, decided again if it lost a sequence race
 * to another writer (R2, 2026-10-30). Two stores confirming at once, or
 * two buyers recording different lines, used to hand one of them
 * "edited by someone else — try again" (and a replayed offline write was
 * dropped). A race lost on every attempt is still reported as CONFLICT.
 */
/**
 * Review RUNAPI-04 (2026-11-09): another run.create took the
 * organisation's live-run slot (mrv_one_active_per_org_unique) or this
 * day's run index (mrv_org_date_index_unique) between this one's checks
 * and its insert.
 */
function isRunSlotConflict(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const name = pgConstraintName(err);
  return name === 'mrv_one_active_per_org_unique' || name === 'mrv_org_date_index_unique';
}

const runCreateRetryable = (err: unknown): boolean =>
  isStreamSeqConflict(err) || isRunSlotConflict(err);

async function withRunStreamRetry<T>(
  ctx: RequestContext,
  fn: (tx: DB) => Promise<T>,
  retryable: (err: unknown) => boolean = isStreamSeqConflict,
): Promise<T> {
  try {
    return await withStreamConflictRetry(() => ctx.withOrg(fn), 3, retryable);
  } catch (err) {
    if (isRunSlotConflict(err)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'run.errors.alreadyPlanned' });
    }
    if (isUniqueViolation(err)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'run.errors.staleSeq' });
    }
    throw err;
  }
}

async function runSimpleCommand(
  ctx: RequestContext,
  runId: string,
  produce: (
    state: RunState,
    scope: {
      runStoreIds?: string[];
      readStoreIds?: ReadonlySet<string> | null;
      nextRunIndex?: number;
    },
  ) => RunEvent[],
  options?: {
    requireGlobalAmend?: boolean;
    requiredPermission?: string;
    skipRunPermissionScope?: boolean;
    /**
     * 2026-10-21 audit CA-29: resolve the run's session stores and hand
     * them to `produce`, so store-keyed commands can reject splits /
     * deliveries to stores outside the run.
     */
    withRunStoreIds?: boolean;
    /**
     * 2026-10-21: resolve the actor's run READ scope (the same resolver
     * run.get redacts with; null = unrestricted) for commands that must
     * not touch splits the actor was never shown.
     */
    withReadScope?: boolean;
    /** Resolve the next free run number on this date (YYYY-MM-DD). */
    nextRunIndexOn?: string;
    /**
     * BUY-6 (2026-10-30): the command touches one item. A purchaser who
     * runs only some of the run's stores may act on it when every store
     * that item serves (and every store the input splits it to) is theirs.
     */
    item?: { skuId: string; splitStoreIds?: readonly string[] };
    /**
     * D9 (2026-10-31): the command adds or removes an off-catalog expense.
     * A purchaser of some of the run's stores may do so when the expense is
     * split only to their stores (the input's splits when adding, the
     * recorded ones when removing).
     */
    expense?: { expenseId: string; splitStoreIds?: readonly string[] };
  },
): Promise<{ lastSeq: number; eventCount: number }> {
  return withRunStreamRetry(ctx, async (tx) => {
    const run = await loadRun(tx, ctx.session!.orgId, runId);
    let state = await loadRunState(tx, run.id);
    const scope: {
      runStoreIds?: string[];
      readStoreIds?: ReadonlySet<string> | null;
      nextRunIndex?: number;
    } = {
      ...(options?.withRunStoreIds ? { runStoreIds: await runInvolvedStoreIds(tx, run) } : {}),
    };
    if (options?.nextRunIndexOn) {
      const [row] = await tx
        .select({ next: sql<number>`coalesce(max(${s.marketRunsV.runIndex}) + 1, 0)::int` })
        .from(s.marketRunsV)
        .where(
          and(
            eq(s.marketRunsV.orgId, ctx.session!.orgId),
            eq(s.marketRunsV.runDate, options.nextRunIndexOn),
            ne(s.marketRunsV.id, run.id),
          ),
        );
      scope.nextRunIndex = row?.next ?? 0;
    }
    if (options?.withReadScope) {
      const readStoreIds = await resolveRunReadStoreScope(tx, ctx);
      scope.readStoreIds = readStoreIds === null ? null : new Set(readStoreIds);
    }
    if (options?.requireGlobalAmend || state.status === 'amending') {
      await assertCanAmendRun(tx, ctx, run);
    } else if (!options?.skipRunPermissionScope) {
      await assertRunPermissionForAllStores(
        tx,
        ctx,
        run,
        options?.requiredPermission ?? 'run.purchase',
        options?.item
          ? {
              ...options.item,
              purchasedStoreIds: (state.items.get(options.item.skuId)?.storeSplits ?? []).map(
                (split) => split.storeId,
              ),
            }
          : undefined,
        options?.expense
          ? [
              ...(options.expense.splitStoreIds ?? []),
              ...(
                state.expenses.find((expense) => expense.id === options.expense!.expenseId)
                  ?.storeSplits ?? []
              ).map((split) => split.storeId),
            ]
          : undefined,
      );
    }
    try {
      const out = produce(state, scope);
      if (out.length === 0) return { lastSeq: state.seq, eventCount: 0 };
      state = await writeRunEvents(tx, ctx.session!.orgId, state, out);
      await dispatchRunEventNotifications(tx, ctx.session!.orgId, ctx.session!.userId, state, out);
      hub.publish(ctx.session!.orgId, {
        type: 'run.changed',
        orgId: ctx.session!.orgId,
        runId: state.streamId,
        lastSeq: state.seq,
      });
      return { lastSeq: state.seq, eventCount: out.length };
    } catch (err) {
      if (err instanceof DomainError) rethrowDomainError(err);
      // A unique violation goes up as-is: withRunStreamRetry decides it
      // again on the fresh stream, then reports CONFLICT if it keeps losing.
      throw err;
    }
  });
}

async function loadRun(db: DB, orgId: string, runId: string) {
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
async function runInvolvedStoreIds(db: DB, run: { sessionIdsJson: string[] }): Promise<string[]> {
  const sessionIds = run.sessionIdsJson;
  if (sessionIds.length === 0) return [];
  const rows = await db.query.orderSessionsV.findMany({
    where: (sess, { inArray }) => inArray(sess.id, sessionIds),
    columns: { storeId: true },
  });
  return [...new Set(rows.map((r) => r.storeId))];
}

/**
 * Resolve the store slice that may be serialized by live run reads.
 *
 * A persisted GLOBAL `run.create.org` grant gets organization-wide run
 * visibility, subject to store-level denies. A store-scoped copy of that key
 * is only a UI affordance in the flat session union and must not widen the
 * read beyond the member's concrete assignments. A genuine org admin still
 * returns `null` through `getActorStoreIds`.
 */
async function resolveRunReadStoreScope(db: DB, ctx: RequestContext): Promise<string[] | null> {
  if (await hasGlobalPermission(db, ctx.session!.memberId, 'run.create.org')) {
    return getActorStoreIdsForPermission(
      db,
      ctx.session!.memberId,
      'run.create.org',
      ctx.session!.permissions,
    );
  }
  return getActorStoreIds(db, ctx.session!.memberId, ctx.session!.permissions);
}

function assertStoreIdsWithinRunCreateScope(
  storeIds: readonly string[],
  allowedStoreIds: readonly string[] | null,
): void {
  if (allowedStoreIds === null) return;
  const allowed = new Set(allowedStoreIds);
  if (storeIds.every((storeId) => allowed.has(storeId))) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.notAssignedToStore',
  });
}

async function assertRunCreateScopeForRun(
  db: DB,
  ctx: RequestContext,
  run: { sessionIdsJson: string[] },
): Promise<void> {
  const allowedStoreIds = await resolveRunCreateStoreScope(db, ctx.session!);
  if (allowedStoreIds === null) return;
  const involvedStoreIds = await runInvolvedStoreIds(db, run);
  const allowed = new Set(allowedStoreIds);
  if (involvedStoreIds.every((storeId) => allowed.has(storeId))) return;
  throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
}

/**
 * `run.amend` is organization-wide authority over settled money. Prove that
 * it comes from an active GLOBAL persisted grant, then resolve it at every
 * store touched by the run so a store-level deny still wins. A store-scoped
 * role may put `run.amend` in the flat session union, but can never satisfy
 * this gate by itself.
 */
async function canAmendRun(
  db: DB,
  ctx: RequestContext,
  run: { sessionIdsJson: string[] },
): Promise<boolean> {
  const globallyGranted = await hasGlobalPermission(db, ctx.session!.memberId, 'run.amend');
  if (!globallyGranted) return false;

  const storeIds = await runInvolvedStoreIds(db, run);
  for (const storeId of storeIds) {
    const effective = await effectivePermissionsForStore(
      db,
      ctx.session!.memberId,
      storeId,
      ctx.session!.permissions,
    );
    if (!effective.has('run.amend')) return false;
  }
  return true;
}

async function assertCanAmendRun(
  db: DB,
  ctx: RequestContext,
  run: { sessionIdsJson: string[] },
): Promise<void> {
  if (await canAmendRun(db, ctx, run)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'run.errors.cannotAmend',
    cause: { missingPermission: 'run.amend' },
  });
}

/**
 * Whole-run mutations affect every store represented by the run. Resolve the
 * command's permission at each concrete store and require full coverage; a
 * permission granted in Store A must never combine with mere membership in
 * Store B to authorize a B-only or A+B mutation. A clean persisted global
 * grant returns `null`, while store-level denies force enumeration and win.
 */
async function assertRunPermissionForAllStores(
  db: DB,
  ctx: RequestContext,
  run: { sessionIdsJson: string[] },
  permissionKey: string,
  item?: {
    skuId: string;
    splitStoreIds?: readonly string[];
    purchasedStoreIds: readonly string[];
  },
  expenseStoreIds?: readonly string[],
): Promise<void> {
  const allowedStoreIds = await getActorStoreIdsForPermission(
    db,
    ctx.session!.memberId,
    permissionKey,
    ctx.session!.permissions,
  );
  if (allowedStoreIds === null) return;
  const involvedStoreIds = await runInvolvedStoreIds(db, run);
  const allowed = new Set(allowedStoreIds);
  if (involvedStoreIds.length > 0 && involvedStoreIds.every((storeId) => allowed.has(storeId))) {
    return;
  }
  const actsInRun = involvedStoreIds.some((storeId) => allowed.has(storeId));
  if (!actsInRun) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
  }
  // BUY-6 (2026-10-30): a purchaser of some of the run's stores may work
  // on an item that serves only their stores.
  if (item) {
    const itemStoreIds = new Set<string>([
      ...(await itemDemandStoreIds(db, run, item.skuId)),
      ...item.purchasedStoreIds,
      ...(item.splitStoreIds ?? []),
    ]);
    if (itemStoreIds.size > 0 && [...itemStoreIds].every((storeId) => allowed.has(storeId))) {
      return;
    }
    throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.itemServesOtherStores' });
  }
  // D9 (2026-10-31): an expense split only to the actor's stores is theirs
  // to record.
  if (expenseStoreIds) {
    if (expenseStoreIds.length > 0 && expenseStoreIds.every((storeId) => allowed.has(storeId))) {
      return;
    }
    throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.expenseServesOtherStores' });
  }
  // Run-wide steps (start delivery, finish, expenses…) still need every store.
  throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.runHasOtherStores' });
}

/**
 * RE-DLV-3: why `run.finish` (or `run.refinalize` while amending) would
 * refuse this actor, as the error key it would answer with; null when it
 * would not refuse on permission grounds. Same checks as the two
 * mutations, read-only. Other phases answer null: there is nothing to
 * finish yet.
 */
async function finishBlockedReasonFor(
  db: DB,
  ctx: RequestContext,
  run: { status: string; sessionIdsJson: string[] },
): Promise<string | null> {
  if (run.status === 'amending') {
    return (await canAmendRun(db, ctx, run)) ? null : 'run.errors.cannotAmend';
  }
  if (run.status !== 'delivering') return null;
  if (!ctx.session!.permissions.has('run.finish')) return 'run.errors.cannotFinish';
  const allowedStoreIds = await getActorStoreIdsForPermission(
    db,
    ctx.session!.memberId,
    'run.finish',
    ctx.session!.permissions,
  );
  if (allowedStoreIds === null) return null;
  const allowed = new Set(allowedStoreIds);
  const involvedStoreIds = await runInvolvedStoreIds(db, run);
  if (involvedStoreIds.length > 0 && involvedStoreIds.every((id) => allowed.has(id))) return null;
  return involvedStoreIds.some((id) => allowed.has(id))
    ? 'run.errors.runHasOtherStores'
    : 'run.errors.cannotFinish';
}

/** Stores whose orders in this run ask for `skuId` (BUY-6). */
async function itemDemandStoreIds(
  db: DB,
  run: { sessionIdsJson: string[] },
  skuId: string,
): Promise<string[]> {
  const sessionIds = run.sessionIdsJson;
  if (sessionIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ storeId: s.orderSessionsV.storeId })
    .from(s.orderItemsV)
    .innerJoin(s.orderSessionsV, eq(s.orderSessionsV.id, s.orderItemsV.sessionId))
    .where(
      and(
        inArray(s.orderItemsV.sessionId, sessionIds),
        eq(s.orderItemsV.skuId, skuId),
        sql`${s.orderItemsV.qty} > 0`,
      ),
    );
  return rows.map((row) => row.storeId);
}
