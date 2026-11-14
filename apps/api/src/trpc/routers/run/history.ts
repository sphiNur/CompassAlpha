/**
 * Finished runs: the history by day, and one run's detail. What they
 * read is services/runHistory.ts (review RUNAPI-13); here are the
 * prices.view scope and the shape of the answer.
 */
import { TRPCError } from '@trpc/server';
import { RunHistoryInputSchema, SimpleRunCommandSchema } from '@compass/contracts';
import { getActorStoreIdsForPermission } from '../../../services/storeScope';
import { authedProcedure } from '../../trpc';
import { runCorrections } from '../../../services/runCorrections';
import { readRunEvents } from '@compass/streams';
import {
  expensesForReader,
  itemsForStoreReader,
  splitsForReader,
} from '../../../services/runReaderView';
import { loadRunSessions, runSessionsView } from '../../../services/runSessionsView';
import { moneyText, runDetailMoney } from '../../../services/runMoney';
import { activeRunExpenses, runLines } from '../../../services/runRead';
import {
  historyPage,
  orgHasStore,
  runDetailMoneyLines,
  supplierNames,
} from '../../../services/runHistory';
import { loadRun } from './command';
import { canAmendRun } from './scope';

export const historyProcedures = {
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
          if (!(await orgHasStore(tx, orgId, query.storeId))) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
          }
          scopedStoreIds = [query.storeId];
        }

        const page = await historyPage(tx, orgId, query, scopedStoreIds);
        const summary = page.summary ?? {
          total_count: 0,
          total: '0',
          items_total: '0',
          expenses_total: '0',
          cash: '0',
          transfer: '0',
          pages: 0,
        };
        const totalPages = Number(summary.pages ?? 0);
        const { pageRows } = page;

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
        for (const row of page.storeTotalRows) {
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
        const { items: allItems, splits: allSplits } = await runLines(tx, run.id);
        const { splits, hiddenSkuIds } = splitsForReader(allItems, allSplits, allowedStoreSet);
        const { sessions, perStoreDemand, sessionNotesByStore, sessionExtrasByStore } =
          await runSessionsView(tx, visibleSessions, sessionItems);
        // Never the organisation's quantities, prices or receipts for a
        // store-scoped history reader.
        const items =
          allowedStoreSet === null
            ? allItems
            : itemsForStoreReader(allItems, splits, perStoreDemand, hiddenSkuIds);

        const rawExpenses = await activeRunExpenses(tx, run.id);
        const expenses = expensesForReader(rawExpenses, allowedStoreSet);

        // DX-HIS-6 (2026-11-01): the detail names each line's supplier.
        const supplierNameById = await supplierNames(tx, ctx.session!.orgId, [
          ...new Set(items.map((item) => item.supplierId).filter((id): id is string => !!id)),
        ]);

        // Review RUNWEB2-03 (2026-11): the money, from the lines the History
        // list row and report.* add up, in the stores this reader may see
        // prices in. The page recomputed it with its own copy of the rule.
        const moneyLines = await runDetailMoneyLines(tx, run.id, allowedStoreIds);
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
};
