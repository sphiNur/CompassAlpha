/**
 * The live runs (run.list) and one run in full (run.get), without money
 * for a member who may not see prices.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema as s } from '@compass/db';
import {
  SimpleRunCommandSchema,
  centsToMoney,
  lineAmount,
  sumMoney,
  toCents,
} from '@compass/contracts';
import {
  effectivePermissionsForStores,
  getActorStoreIdsForPermission,
} from '../../../services/storeScope';
import { replayRun } from '@compass/domain/run';
import { authedProcedure } from '../../trpc';
import {
  canSeePrices,
  priceStoreIds,
  pricesVisibleFor,
  withoutPrices,
} from '../../../services/priceRedaction';
import { readRunEvents } from '@compass/streams';
import {
  expensesForReader,
  itemsForStoreReader,
  splitsForReader,
} from '../../../services/runReaderView';
import { loadRunSessions, runSessionsView } from '../../../services/runSessionsView';
import { runMoneyLinesSql, uuidListSql } from '../../../services/runMoney';
import { inUuids } from '../../../services/sqlIn';
import { executeRows } from '../../../services/sqlRows';
import { splitsInheritingItemPayment } from '../../../services/scopedRunRevision';
import { loadRun } from './command';
import { runInvolvedStoreIds, resolveRunReadStoreScope, finishBlockedReasonFor } from './scope';

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

export const readProcedures = {
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
        // Review RUNAPI-12 (2026-11-12): read once here; the dispatch and
        // finish checks below reuse it.
        const involvedStoreIds = await runInvolvedStoreIds(tx, run);
        if (allowedStoreSet) {
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
          const visibleStoreIds = involvedStoreIds.filter(
            (storeId) => !allowedStoreSet || allowedStoreSet.has(storeId),
          );
          const permsByStore = await effectivePermissionsForStores(
            tx,
            ctx.session!.memberId,
            visibleStoreIds,
          );
          for (const storeId of visibleStoreIds) {
            if (!permsByStore.get(storeId)?.has('delivery.dispatch')) {
              dispatchDeniedStoreIds.push(storeId);
            }
          }
        }

        // RE-DLV-3 (2026-10-31): whether this actor may finish (or close
        // the correction of) the run, so the screen can say why up front
        // instead of answering 403 after the summary sheet.
        const finishBlockedReason = await finishBlockedReasonFor(tx, ctx, {
          ...run,
          involvedStoreIds,
        });

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
                actualTotal: run.actualTotal === null ? null : sumMoney(visibleMoney.total),
                actualCashTotal: run.actualCashTotal === null ? null : sumMoney(visibleMoney.cash),
                actualTransferTotal:
                  run.actualTransferTotal === null ? null : sumMoney(visibleMoney.transfer),
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
};
