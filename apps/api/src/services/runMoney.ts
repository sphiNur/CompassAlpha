/**
 * 2026-10-21 CA-11: the ONE purchase-money definition, as SQL.
 *
 * The audit counted four to six different "how much did this run cost"
 * figures (finance report, history page, finish sheet, frozen
 * actual_total, notification) that disagreed with each other. The rule
 * every surface now follows:
 *
 *   items    = Σ split.qty × COALESCE(split override price, item price)
 *              over purchased SKU rows, paid by
 *              COALESCE(split override method, item method, 'cash')
 *   expenses = Σ expense split qty × expense unit price over active
 *              (not removed) off-catalog expenses, paid by the expense's
 *              method
 *   total    = items + expenses, always shown as items / expenses / total
 *
 * `runMoneyLinesSql` yields one row per money line, attributed to a
 * store, so run.history, run.list and report.* all aggregate the same
 * rows and therefore cannot drift apart. The frozen
 * market_runs_v.actual_total is the items-only part (see RunFinished).
 *
 * D1 (2026-10-31): `amount` is ROUND(qty × price, 2) — each line rounded
 * half-up to cents, the same rule as `lineCents` in @compass/contracts
 * (the domain's frozen RunFinished totals, run.get and the web use that).
 * Sums of these lines are exact 2-decimal numerics, so a store's total,
 * a day's group and the headline figure always add up. Before, the lines
 * kept the half cents (0.5 × 2.01 = 1.005) and every reader rounded at a
 * different step, one cent apart on one screen (R2-HIS-1). Events keep
 * their stored values; this changes only what is derived from them.
 *
 * Columns: run_id, store_id, kind ('item' | 'expense'), sku_id,
 * expense_id, label, supplier_id, unit_price, qty, amount, payment_method.
 */
import { sumMoney, toCents } from '@compass/contracts';
import { sql, type SQL } from 'drizzle-orm';

export function runMoneyLinesSql(args: {
  /** A relation with an `id` column holding the run ids to include. */
  runsSql: SQL;
  /** Comma-joined `uuid` list of visible stores, or null = every store. */
  storeIdsSql: SQL | null;
}): SQL {
  const itemScope = args.storeIdsSql ? sql`AND ris.store_id IN (${args.storeIdsSql})` : sql``;
  const expenseScope = args.storeIdsSql
    ? sql`AND (expense_split.value->>'storeId')::uuid IN (${args.storeIdsSql})`
    : sql``;
  return sql`
    SELECT
      ris.run_id,
      ris.store_id,
      'item'::text AS kind,
      ris.sku_id,
      NULL::uuid AS expense_id,
      NULL::text AS label,
      ri.supplier_id,
      COALESCE(ris.unit_price, ri.unit_price, 0) AS unit_price,
      ris.qty,
      ROUND(ris.qty * COALESCE(ris.unit_price, ri.unit_price, 0), 2) AS amount,
      COALESCE(ris.payment_method, ri.payment_method, 'cash') AS payment_method
    FROM ${args.runsSql} money_runs
    INNER JOIN read_model.run_items_v ri ON ri.run_id = money_runs.id
    INNER JOIN read_model.run_item_stores_v ris
      ON ris.run_id = ri.run_id AND ris.sku_id = ri.sku_id
    WHERE ri.status = 'purchased'
      ${itemScope}
    UNION ALL
    SELECT
      expense.run_id,
      (expense_split.value->>'storeId')::uuid AS store_id,
      'expense'::text AS kind,
      NULL::uuid AS sku_id,
      expense.id AS expense_id,
      expense.label::text AS label,
      NULL::uuid AS supplier_id,
      expense.unit_price,
      COALESCE(NULLIF(expense_split.value->>'qty', '')::numeric, 0) AS qty,
      ROUND(
        COALESCE(NULLIF(expense_split.value->>'qty', '')::numeric, 0) * expense.unit_price,
        2
      ) AS amount,
      expense.payment_method
    FROM ${args.runsSql} money_runs
    INNER JOIN read_model.run_expenses_v expense ON expense.run_id = money_runs.id
    CROSS JOIN LATERAL jsonb_array_elements(expense.store_splits_json)
      AS expense_split(value)
    WHERE expense.removed_at IS NULL
      ${expenseScope}
  `;
}

/** Comma-joined `::uuid` list for `runMoneyLinesSql`, or null for "all". */
export function uuidListSql(ids: readonly string[] | null): SQL | null {
  if (ids === null) return null;
  // An empty IN-list is a syntax error; the nil UUID never matches.
  if (ids.length === 0) return sql`'00000000-0000-0000-0000-000000000000'::uuid`;
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/**
 * A numeric money text from SQL ("12.30", "0", null) as a 2-decimal
 * string, without going through a float.
 */
export function moneyText(value: string | null | undefined): string {
  return sumMoney([value ?? '0']);
}

/** One row of `runMoneyLinesSql`, as `run.historyDetail` reads it. */
export interface RunMoneyLine {
  storeId: string;
  kind: 'item' | 'expense';
  skuId: string | null;
  expenseId: string | null;
  amount: string;
  paymentMethod: string | null;
}

/** Items / expenses / total of some money lines, and how they were paid. */
export interface MoneyTotals {
  total: string;
  itemsTotal: string;
  expensesTotal: string;
  cash: string;
  transfer: string;
}

/**
 * The same sums run.history makes in SQL (`visible_totals`): a line counts
 * as cash or transfer only when its method says so.
 */
export function moneyTotals(lines: readonly RunMoneyLine[]): MoneyTotals {
  const sum = (keep: (line: RunMoneyLine) => boolean) =>
    sumMoney(lines.filter(keep).map((line) => line.amount));
  return {
    total: sum(() => true),
    itemsTotal: sum((line) => line.kind === 'item'),
    expensesTotal: sum((line) => line.kind === 'expense'),
    cash: sum((line) => line.paymentMethod === 'cash'),
    transfer: sum((line) => line.paymentMethod === 'transfer'),
  };
}

function groupLines(
  lines: readonly RunMoneyLine[],
  key: (line: RunMoneyLine) => string | null,
): Map<string, RunMoneyLine[]> {
  const groups = new Map<string, RunMoneyLine[]>();
  for (const line of lines) {
    const k = key(line);
    if (k === null) continue;
    const group = groups.get(k) ?? [];
    group.push(line);
    groups.set(k, group);
  }
  return groups;
}

/**
 * Review RUNWEB2-03 (2026-11): a run's money for the History detail, made
 * from its money lines in the stores the reader may see prices in: the
 * rows the History list and report.* add up. The detail page used to
 * recompute it in the browser with a fourth copy of the rule, so a change
 * to the rule could make the detail disagree with the list row it opened.
 *
 *   - the run, and each store (largest first), as `MoneyTotals`, with the
 *     number of products and expenses that store pays for;
 *   - per product (SKU) and per split (`skuId|storeId`): what it cost;
 *   - per expense: its share in those stores.
 */
export function runDetailMoney(lines: readonly RunMoneyLine[]) {
  const byStore = [...groupLines(lines, (line) => line.storeId)].map(([storeId, storeLines]) => ({
    storeId,
    ...moneyTotals(storeLines),
    itemCount: new Set(storeLines.flatMap((line) => (line.skuId ? [line.skuId] : []))).size,
    expenseCount: new Set(storeLines.flatMap((line) => (line.expenseId ? [line.expenseId] : [])))
      .size,
  }));
  byStore.sort((a, b) => {
    const diff = toCents(b.total) - toCents(a.total);
    return diff > 0n ? 1 : diff < 0n ? -1 : a.storeId < b.storeId ? -1 : 1;
  });
  const sums = (key: (line: RunMoneyLine) => string | null) =>
    new Map([...groupLines(lines, key)].map(([k, group]) => [k, moneyTotals(group)]));
  return {
    ...moneyTotals(lines),
    byStore,
    bySku: sums((line) => line.skuId),
    bySplit: sums((line) => (line.skuId ? `${line.skuId}|${line.storeId}` : null)),
    byExpense: sums((line) => line.expenseId),
  };
}
