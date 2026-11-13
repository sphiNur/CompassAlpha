/**
 * The live runs (run.list) and one run in full (run.get), without money
 * for a member who may not see prices. What they read is
 * services/runRead.ts (review RUNAPI-13); here are who may read what and
 * the shape of the answer.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema as s } from '@compass/db';
import {
  RunStoreProgressInputSchema,
  SimpleRunCommandSchema,
  centsToMoney,
  lineAmount,
  sumMoney,
} from '@compass/contracts';
import {
  effectivePermissionsForStores,
  getActorStoreIdsForPermission,
} from '../../../services/storeScope';
import { authedProcedure } from '../../trpc';
import {
  canSeePrices,
  priceStoreIds,
  redactMoneyFor,
  withoutPrices,
} from '../../../services/priceRedaction';
import {
  expensesForReader,
  itemsForStoreReader,
  splitsForReader,
} from '../../../services/runReaderView';
import { loadRunSessions, runSessionsView } from '../../../services/runSessionsView';
import {
  activeRunExpenses,
  demandStorePairs,
  lastPricesBefore,
  listedRuns,
  memberDisplayNames,
  preferredSuppliers,
  runLines,
  runStoreTotals,
  runStreamFacts,
  sessionStores,
  type RunStoreTotal,
} from '../../../services/runRead';
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

export const readProcedures = {
  list: runReadProcedure.query(async ({ ctx }) => {
    return ctx.withOrg(async (tx) => {
      // A flat session permission is a union across role scopes and cannot
      // prove organization-wide read authority. Resolve the persisted
      // provenance first; store-scoped readers receive a redacted projection
      // below rather than the raw cross-store run row.
      const allowedStoreIds = await resolveRunReadStoreScope(tx, ctx);
      if (allowedStoreIds !== null && allowedStoreIds.length === 0) return [];
      // Review RUNAPI-06: the store scope is applied in SQL, before the
      // limit, and a run still open is listed however old it is.
      const runs = await listedRuns(tx, ctx.session!.orgId, allowedStoreIds);
      // Resolve every involved storeId in one shot; cheap join on a
      // bounded result set.
      const allSessionIds = [...new Set(runs.flatMap((r) => r.sessionIdsJson))];
      const allowedStoreSet = allowedStoreIds === null ? null : new Set(allowedStoreIds);
      // D6 (2026-10-31): money per run only where prices.view holds in
      // every store of the run the reader sees.
      const priceStores = await priceStoreIds(tx, ctx.session!);
      // DX-DLV-13 (2026-11-01): always resolved now — each row names the
      // visible stores it serves (`storeIds`), so a store's receiving page
      // can tell "on the way" from "nothing for you".
      const sessionStore = await sessionStores(tx, allSessionIds);
      const visibleRuns = runs;
      if (visibleRuns.length === 0) return [];

      // CA-11 / D1: per-store money from the shared money lines, in cents.
      const totalsByRun = await runStoreTotals(
        tx,
        visibleRuns.map((r) => r.id),
        allowedStoreIds,
      );

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
        return redactMoneyFor(priceStores, storeIds, row);
      });

      function listRow(run: (typeof visibleRuns)[number]) {
        const storeTotalRows: RunStoreTotal[] = [...(totalsByRun.get(run.id)?.values() ?? [])].sort(
          (a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0),
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

        // In the read model's key order (2026-07-26, see runLines).
        const { items: allItems, splits: allSplits } = await runLines(tx, run.id);
        type VisibleRunItem = Omit<(typeof allItems)[number], 'paymentMethod'> & {
          paymentMethod: string | null;
          /** BUY-5: demand that joined after the item was decided. */
          topUpQty?: string | null;
        };
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

        // BUY-5 (2026-10-30): "still need X" lives in the domain state only
        // (no read-model column); DX-DLV-13: the stores whose delivery was
        // recalled, of those this reader sees.
        const streamFacts = await runStreamFacts(tx, run.id);
        items = items.map((it) => ({
          ...it,
          topUpQty: streamFacts.topUpQtyBySku.get(it.skuId) ?? null,
        }));
        const recalledStoreIds = streamFacts.recalledStoreIds.filter(
          (storeId) => !allowedStoreSet || allowedStoreSet.has(storeId),
        );

        // M3.27 (2026-05-18): preferred-supplier mapping for the
        // active-run "by vendor" view.
        const supplierBySku = await preferredSuppliers(
          tx,
          items.map((it) => it.skuId),
        );

        // Most-recent observed unit_price per SKU, across all past runs,
        // and when (2026-07-26). Kept as a PARALLEL map rather than
        // changing lastPriceBySku's shape: that field feeds the inline
        // price prefill in three mount sites, and reshaping the money
        // path to add a timestamp is a bad trade.
        const { lastPriceBySku, lastPriceObservedAtBySku } = await lastPricesBefore(
          tx,
          ctx.session!.orgId,
          run.id,
          items.map((it) => it.skuId),
          allowedStoreSet === null
            ? null
            : [
                ...new Set([
                  ...perStoreDemand.map((row) => row.storeId),
                  ...splits.map((row) => row.storeId),
                ]),
              ],
        );
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
          const byId = await memberDisplayNames(tx, [...claimerIds]);
          if (run.claimedByMemberId) {
            claimedByDisplayName = byId.get(run.claimedByMemberId) ?? null;
          }
          if (run.previousClaimerMemberId) {
            previousClaimerDisplayName = byId.get(run.previousClaimerMemberId) ?? null;
          }
        }
        // M3.44 (2026-05-22): active expenses for this run. Only the
        // non-removed ones make it into the FE payload.
        const rawExpenses = await activeRunExpenses(tx, run.id);
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
          const demandRows = await demandStorePairs(tx, run.sessionIdsJson);
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
        return redactMoneyFor(priceStores, shownStoreIds, payload);
      });
    }),

  /**
   * Review ORD-26 (2026-11): how far one store's part of a run has got,
   * for the order page's banner on an order in a run (InRunBanner). It
   * read the whole of run.get (items, demand, prices, suppliers, events)
   * for this. The checks are run.get's: a reader limited to some stores
   * sees a run only when it serves one of them, and of a store outside
   * that scope sees nothing (run.get leaves its splits and recall out).
   * The shape is the part of run.get the banner reads, for that store.
   */
  storeProgress: runReadProcedure
    .input(RunStoreProgressInputSchema)
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const run = await loadRun(tx, ctx.session!.orgId, input.runId);
        const allowedStoreIds = await resolveRunReadStoreScope(tx, ctx);
        if (allowedStoreIds !== null) {
          const involvedStoreIds = await runInvolvedStoreIds(tx, run);
          if (!involvedStoreIds.some((storeId) => allowedStoreIds.includes(storeId))) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
          }
        }
        const progress = {
          status: run.status,
          splits: [] as Array<{
            storeId: string;
            deliveredAt: string | null;
            confirmedAt: string | null;
          }>,
          recalledStoreIds: [] as string[],
        };
        if (allowedStoreIds !== null && !allowedStoreIds.includes(input.storeId)) {
          return progress;
        }
        const splits = await tx
          .select({
            deliveredAt: s.runItemStoresV.deliveredAt,
            confirmedAt: s.runItemStoresV.confirmedAt,
          })
          .from(s.runItemStoresV)
          .where(
            and(eq(s.runItemStoresV.runId, run.id), eq(s.runItemStoresV.storeId, input.storeId)),
          );
        progress.splits = splits.map((split) => ({
          storeId: input.storeId,
          deliveredAt: split.deliveredAt?.toISOString() ?? null,
          confirmedAt: split.confirmedAt?.toISOString() ?? null,
        }));
        // DX-DLV-13: recalled when the store's last delivery event undid
        // its delivery, as run.get works it out from the whole stream.
        const [lastDelivery] = await tx
          .select({ type: s.events.type })
          .from(s.events)
          .where(
            and(
              eq(s.events.streamType, 'run'),
              eq(s.events.streamId, run.id),
              inArray(s.events.type, ['StoreDelivered', 'StoreDeliveryUndone']),
              sql`${s.events.payload}->>'storeId' = ${input.storeId}`,
            ),
          )
          .orderBy(desc(s.events.seq))
          .limit(1);
        if (lastDelivery?.type === 'StoreDeliveryUndone') {
          progress.recalledStoreIds = [input.storeId];
        }
        return progress;
      });
    }),
};
