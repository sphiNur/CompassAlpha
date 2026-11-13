/**
 * Admin → Operations → Finance: what was paid in a date range, by day, by
 * stall or by store. Review ADM2-10 (2026-11-11): its own file, the three
 * views grouped by financeGroups.ts and drawn by one FinanceGroupRow.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  Chip,
  ChipBar,
  DataState,
  EmptyState,
  Input,
  LoadingState,
  SectionLabel,
  Select,
  rowGroupClass,
  useToast,
} from '@compass/ui';
import { trpc } from '../../../../lib/trpc';
import { copyText } from '../../../../lib/clipboard';
import { useAuthStore } from '../../../../stores/authStore';
import { formatMoney, formatQty, toQtyInput } from '../../../../lib/format';
import {
  useDateFormat,
  useI18n,
  useProductNameParts,
  useUnitLabel,
} from '../../../../hooks/useI18n';
import { useReportStore } from '../../../../hooks/useReportStore';
import { financePresetRange } from '../financeDates';
import { FinanceGroupRow } from './FinanceGroupRow';
import {
  EXPENSE_GROUP,
  NO_SUPPLIER_GROUP,
  groupFinanceLines,
  type FinanceView,
} from './financeGroups';

// ============ Finance reconciliation (M1.15) ============
//
// Three views over the same data set (purchaseLines):
//   - Daily: per-day totals (cash + transfer) for the picked range,
//     plus an expandable per-day SKU breakdown.
//   - By supplier: rolled up totals per supplier, with cash/transfer
//     split. Empty supplier_id bucketed as "—".
//   - By store: rolled up totals per destination store.
//
// Date picker presets: today / yesterday / this month / last month /
// custom. The picked range is the input for ALL three tabs (they
// share the same underlying purchaseLines query, just regrouped client
// side). This keeps the API surface small (M1.14 + M1.15 introduced
// only one tRPC namespace: `report`).
//
// Permissions: `users.manage` (Admin gate). A future M1.x can split
// out `finance.view` for accounting-only Telegram accounts.

type FinancePreset = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth' | 'custom';

export function FinanceSection() {
  const i18n = useI18n();
  const dates = useDateFormat();
  const toast = useToast();
  const productNameParts = useProductNameParts();
  const unitLabel = useUnitLabel();
  // D10 (2026-10-31): copying as TSV needs reports.export.
  const canExport = useAuthStore((s) => s.session?.permissions.includes('reports.export') ?? false);
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  // HIS-19: names only, and readable by finance readers who are not
  // admins; archived stalls keep their names in old periods.
  const suppliersQuery = trpc.catalog.suppliers.useQuery({ includeArchived: true });
  // HIS-19: the stores finance covers (reports.view ∪ users.manage).
  const storesQuery = trpc.catalog.stores.useQuery({ permission: 'finance' });
  // CMP-HIS-1 (2026-10-31): the top bar's store, not every store's money
  // under one store's name. '' = all stores.
  const reportStore = useReportStore(storesQuery.data ?? (storesQuery.isError ? [] : undefined));
  const storeId = reportStore.storeId || undefined;

  // Date range. Default to "this month" since that's the most common
  // reconciliation cadence (monthly bank statement vs. cash drawer
  // closing). Custom range lets the user widen / narrow on demand.
  // 2026-10-21 audit CA-23 (D-05): presets read the LOCAL calendar via
  // financePresetRange — `toISOString()` shifted them a day east of UTC.
  // HIS-13 (2026-10-30): the org's calendar, not the device's — a phone set
  // to UTC turned Tashkent's "today" into yesterday until 05:00.
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const [preset, setPreset] = useState<FinancePreset>('thisMonth');
  const [startDate, setStartDate] = useState<string>(
    () => financePresetRange('thisMonth', new Date(), orgTimeZone).startDate,
  );
  const [endDate, setEndDate] = useState<string>(
    () => financePresetRange('thisMonth', new Date(), orgTimeZone).endDate,
  );

  // Apply preset → derive [start, end]. Custom keeps whatever the user
  // typed in the two inputs. Review ADM2-35 (2026-11-11): again when the
  // org's time zone arrives after the first render (it read the device's).
  useEffect(() => {
    if (preset === 'custom') return;
    const range = financePresetRange(preset, new Date(), orgTimeZone);
    setStartDate(range.startDate);
    setEndDate(range.endDate);
  }, [preset, orgTimeZone]);

  const [view, setView] = useState<FinanceView>('daily');

  // HIS-12 (2026-10-30): an empty or reversed custom range used to show
  // "no purchases in this range", or fail three times into "unknown error".
  const rangeOk =
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
    /^\d{4}-\d{2}-\d{2}$/.test(endDate) &&
    startDate <= endDate;
  const linesQuery = trpc.report.purchaseLines.useQuery(
    { startDate, endDate, storeId },
    { enabled: rangeOk && reportStore.ready },
  );
  const totalsQuery = trpc.report.totals.useQuery(
    { startDate, endDate, storeId },
    { enabled: rangeOk && reportStore.ready },
  );

  // Lookup tables for joining ids → display names.
  const skuById = useMemo(() => {
    const m = new Map<string, { names: Record<string, string>; unit: string }>();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, { names: sku.names, unit: sku.unit });
    }
    return m;
  }, [skusQuery.data]);

  const supplierById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of suppliersQuery.data ?? []) m.set(s.id, s.name);
    return m;
  }, [suppliersQuery.data]);

  const storeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of storesQuery.data ?? []) m.set(s.id, s.name);
    return m;
  }, [storesQuery.data]);

  const lines = useMemo(() => linesQuery.data ?? [], [linesQuery.data]);

  /**
   * 2026-10-21 CA-11: purchaseLines now also carries off-catalog expense
   * splits (`kind: 'expense'`, skuId null, free-text label), so finance
   * shows the same money as History and the finish sheet. One name
   * resolver for both kinds. Review ADM2-15 (2026-11-11): a named expense
   * says so in words ("Expense: Taxi"), not with a 🧾 (UI-1). Review
   * COREWEB2-18 (2026-11-12): a product in the reader's language only.
   * The second language is for matching what a vendor reads, and the
   * line had the method, the name and "(second name)" cut off on one line.
   */
  const plainLineName = useCallback(
    (l: (typeof lines)[number]): string => {
      if (l.kind === 'expense' || !l.skuId) return l.label ?? i18n.t('finance.label.expense');
      const sku = skuById.get(l.skuId);
      return sku ? productNameParts(sku).primary : i18n.t('common.unknownProduct');
    },
    [skuById, productNameParts, i18n],
  );
  const lineName = useCallback(
    (l: (typeof lines)[number]): string =>
      (l.kind === 'expense' || !l.skuId) && l.label
        ? i18n.t('finance.label.expenseNamed', { name: l.label })
        : plainLineName(l),
    [plainLineName, i18n],
  );
  // HIS-15 (2026-10-31): quantities as everywhere else — trailing zeros
  // dropped, with the product's unit ("0.5 公斤", not "0.500").
  const lineQty = useCallback(
    (l: (typeof lines)[number]): string => {
      const sku = l.skuId ? skuById.get(l.skuId) : undefined;
      return sku ? `${formatQty(l.qty)} ${unitLabel(sku.unit, l.qty)}` : formatQty(l.qty);
    },
    [skuById, unitLabel],
  );
  const methodLabel = useCallback(
    (method: string) =>
      method === 'transfer' ? i18n.t('run.label.paymentTransfer') : i18n.t('run.label.paymentCash'),
    [i18n],
  );
  const lineKey = (l: (typeof lines)[number], i: number) =>
    `${l.runId}-${l.skuId ?? l.expenseId}-${l.storeId}-${i}`;

  // The open view's groups (ADM2-10: one grouping for the three views).
  const groups = useMemo(() => groupFinanceLines(lines, view), [lines, view]);
  const groupTitle = (key: string): string => {
    if (view === 'daily') return dates.calendarDay(key);
    if (view === 'byStore') return storeById.get(key) ?? i18n.t('common.unknownStore');
    if (key === EXPENSE_GROUP) return i18n.t('finance.label.expenses');
    if (key === NO_SUPPLIER_GROUP) return `— ${i18n.t('finance.label.noSupplier')}`;
    return supplierById.get(key) ?? i18n.t('common.unknownSupplier');
  };

  // Which group's lines are open, in whichever view (one at a time).
  const [expanded, setExpanded] = useState<string | null>(null);

  // Export as text → clipboard. Telegram WebApp can't easily download
  // files, but every supported client can paste into a Telegram chat.
  // The shape is human-readable + machine-parseable (TSV) so finance
  // can drop it straight into their spreadsheet.
  const exportText = useCallback(() => {
    // HIS-15 (2026-10-31): headers and payment methods in the reader's
    // language; numbers stay plain (no thousands separators) so a
    // spreadsheet reads them as numbers.
    const lineHeader = [
      i18n.t('finance.tsv.date'),
      i18n.t('finance.tsv.run'),
      i18n.t('finance.tsv.item'),
      i18n.t('finance.tsv.store'),
      i18n.t('finance.tsv.supplier'),
      i18n.t('finance.tsv.method'),
      i18n.t('finance.tsv.qty'),
      i18n.t('finance.tsv.unit'),
      i18n.t('finance.tsv.unitPrice'),
      i18n.t('finance.tsv.total'),
    ].join('\t');
    const tsv = [
      `# ${i18n.t('finance.tsv.title', { start: startDate, end: endDate })} · ${
        reportStore.storeId
          ? (storeById.get(reportStore.storeId) ?? i18n.t('common.unknownStore'))
          : i18n.t('run.history.allStores')
      }`,
      lineHeader,
      ...lines.map((l) => {
        const sku = l.skuId ? skuById.get(l.skuId) : undefined;
        return [
          l.runDate,
          `#${l.runIndex + 1}`,
          plainLineName(l),
          storeById.get(l.storeId) ?? i18n.t('common.unknownStore'),
          l.supplierId ? (supplierById.get(l.supplierId) ?? i18n.t('common.unknownSupplier')) : '—',
          methodLabel(l.paymentMethod),
          toQtyInput(l.qty),
          sku ? unitLabel.uncounted(sku.unit) : '',
          l.unitPrice ?? '',
          l.lineTotal ?? '',
        ].join('\t');
      }),
    ].join('\n');
    // HIS-8 (2026-10-30): the write can be refused (no clipboard
    // permission); only claim success once it actually happened.
    void copyText(tsv).then((copied) =>
      copied
        ? toast.success(i18n.t('finance.export.copied'))
        : toast.error(i18n.t('finance.export.noClipboard')),
    );
  }, [
    lines,
    plainLineName,
    methodLabel,
    skuById,
    unitLabel,
    storeById,
    supplierById,
    startDate,
    endDate,
    reportStore.storeId,
    toast,
    i18n,
  ]);

  return (
    <div className="px-4 py-3">
      {/* Range picker: the store, the preset chips (DX-HIS-3 below) and, for
          a custom range, two dates. */}
      <Card className="mb-3 flex flex-col gap-2 p-3">
        {/* CMP-HIS-1: which stores every amount below covers. */}
        <Select
          value={reportStore.storeId}
          onChange={(e) => reportStore.setStoreId(e.currentTarget.value)}
          aria-label={i18n.t('run.history.storeFilter')}
        >
          <option value="">{i18n.t('run.history.allStores')}</option>
          {(storesQuery.data ?? []).map((store) => (
            <option key={store.id} value={store.id}>
              {store.name}
            </option>
          ))}
        </Select>
        {/* DX-HIS-3 (2026-11-01): wrapping chips, not a segmented bar. In
            ru / uz at 360 px the five presets were 465 px wide in a 304 px
            card and «Произвольный» ran off screen. */}
        <ChipBar ariaLabel={i18n.t('finance.range.presets')} wrap>
          {(
            [
              ['today', 'finance.preset.today'],
              ['yesterday', 'finance.preset.yesterday'],
              ['thisMonth', 'finance.preset.thisMonth'],
              ['lastMonth', 'finance.preset.lastMonth'],
              ['custom', 'finance.preset.custom'],
            ] as const
          ).map(([value, label]) => (
            <Chip key={value} selected={preset === value} onClick={() => setPreset(value)}>
              {i18n.t(label)}
            </Chip>
          ))}
        </ChipBar>
        {preset === 'custom' ? (
          // ADM2-13: at 320px both dates lost their year («11/01/202»). Each
          // keeps 9rem; when the row is narrower the end date goes to a
          // second line, with its dash.
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              aria-label={i18n.t('finance.range.start')}
              className="min-w-[9rem] flex-1"
            />
            <div className="flex flex-1 items-center gap-2">
              <span className="text-old-body text-[var(--c-fg-muted)]">—</span>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-label={i18n.t('finance.range.end')}
                className="min-w-[9rem]"
              />
            </div>
          </div>
        ) : (
          <div className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {dates.calendarDay(startDate)} → {dates.calendarDay(endDate)}
          </div>
        )}
      </Card>

      {/* Totals scorecard.
          2026-10-21 FE-01 (F6-04): a failed totals query used to make the
          card silently vanish; show the error + Retry instead. */}
      {totalsQuery.isError ? (
        <div className="mb-3">
          <DataState query={totalsQuery}>{() => null}</DataState>
        </div>
      ) : totalsQuery.data ? (
        // R2-HIS-4 (2026-10-31): three 2-dp amounts side by side overflowed
        // at 360/390 wide; cash and transfer share a row, the total gets
        // its own. D6: without prices.view the money is left out by the
        // server and only the counts show.
        <Card className="mb-3 grid grid-cols-2 gap-x-2 gap-y-2 p-3">
          <div className="min-w-0">
            <SectionLabel padded={false}>{i18n.t('run.label.paymentCash')}</SectionLabel>
            {totalsQuery.data.totalCash !== null ? (
              <div className="break-all text-old-h2 font-semibold tabular-nums">
                {formatMoney(totalsQuery.data.totalCash)}
              </div>
            ) : null}
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('finance.count.lines', { n: totalsQuery.data.cashLines })}
            </div>
          </div>
          <div className="min-w-0">
            <SectionLabel padded={false}>{i18n.t('run.label.paymentTransfer')}</SectionLabel>
            {totalsQuery.data.totalTransfer !== null ? (
              <div className="break-all text-old-h2 font-semibold tabular-nums">
                {formatMoney(totalsQuery.data.totalTransfer)}
              </div>
            ) : null}
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('finance.count.lines', { n: totalsQuery.data.transferLines })}
            </div>
          </div>
          <div className="col-span-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 border-t border-[var(--c-divider)] pt-2">
            <div className="min-w-0">
              <SectionLabel padded={false}>{i18n.t('finance.label.total')}</SectionLabel>
              {totalsQuery.data.total !== null ? (
                <div className="break-all text-old-h2 font-semibold tabular-nums">
                  {formatMoney(totalsQuery.data.total)}
                </div>
              ) : null}
            </div>
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('finance.count.runs', { n: totalsQuery.data.runCount })}
            </div>
          </div>
          {/* 2026-10-21 CA-11: total = items + expenses, shown as parts. */}
          {totalsQuery.data.itemsTotal !== null && totalsQuery.data.expensesTotal !== null ? (
            <div className="col-span-2 text-old-label tabular-nums text-[var(--c-fg-muted)]">
              {i18n.t('run.money.itemsExpenses', {
                items: formatMoney(totalsQuery.data.itemsTotal),
                expenses: formatMoney(totalsQuery.data.expensesTotal),
              })}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* View switcher + export (a real <Button> at sm/pearl, M3.17).
          DX-HIS-3: the export button gets its own line when the three
          views need the width (ru / uz at 360 px squeezed it to 24 px). */}
      <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
        {/* DX-HIS-3: chips that wrap; in uz at 360 px the three views
            were 355 px in 328 and 「Doʻkon boʻyicha」 was cut off. */}
        <ChipBar ariaLabel={i18n.t('finance.view.label')} className="min-w-[11rem] flex-1" wrap>
          {(
            [
              ['daily', 'finance.view.daily'],
              ['bySupplier', 'finance.view.bySupplier'],
              ['byStore', 'finance.view.byStore'],
            ] as const
          ).map(([value, label]) => (
            <Chip
              key={value}
              selected={view === value}
              onClick={() => {
                setView(value);
                setExpanded(null);
              }}
            >
              {i18n.t(label)}
            </Chip>
          ))}
        </ChipBar>
        {canExport ? (
          <Button
            size="sm"
            variant="pearl"
            onClick={exportText}
            disabled={lines.length === 0}
            aria-label={i18n.t('finance.export.label')}
          >
            {i18n.t('finance.export.label')}
          </Button>
        ) : null}
      </div>

      {!rangeOk ? (
        <Banner tone="warn" title={i18n.t('finance.errors.invalidRange')} />
      ) : linesQuery.isLoading ? (
        <LoadingState variant="compact" />
      ) : linesQuery.isError ? (
        // 2026-10-21 FE-01 (F6-04): was rendered as "no expenses".
        <DataState query={linesQuery}>{() => null}</DataState>
      ) : lines.length === 0 ? (
        <EmptyState
          title={i18n.t('finance.empty.title')}
          description={i18n.t('finance.empty.description')}
        />
      ) : (
        <ul className={rowGroupClass} role="list">
          {groups.map((g) => (
            <FinanceGroupRow
              key={g.key}
              title={groupTitle(g.key)}
              titleClassName={view === 'daily' ? 'tabular-nums' : 'truncate'}
              group={g}
              open={expanded === g.key}
              onToggle={() => setExpanded(expanded === g.key ? null : g.key)}
            >
              {g.lines.map((l, i) =>
                view === 'daily' ? (
                  <li
                    key={lineKey(l, i)}
                    className="flex flex-col gap-0.5 border-b border-[var(--c-divider)] px-3 py-2 last:border-b-0"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-old-body font-medium">
                        {methodLabel(l.paymentMethod)} {lineName(l)}
                      </span>
                      <span className="text-old-body tabular-nums">{formatMoney(l.lineTotal)}</span>
                    </div>
                    <div className="flex items-baseline gap-2 text-old-label text-[var(--c-fg-muted)]">
                      <span>{storeById.get(l.storeId) ?? i18n.t('common.unknownStore')}</span>
                      <span>· {l.supplierId ? (supplierById.get(l.supplierId) ?? '—') : '—'}</span>
                      <span className="ml-auto tabular-nums">
                        {l.unitPrice !== null
                          ? `${lineQty(l)} × ${formatMoney(l.unitPrice)}`
                          : lineQty(l)}
                      </span>
                    </div>
                  </li>
                ) : (
                  <li
                    key={lineKey(l, i)}
                    className="flex items-baseline justify-between gap-2 border-b border-[var(--c-divider)] px-3 py-1.5 text-old-label last:border-b-0"
                  >
                    <span className="truncate">
                      {dates.calendarDay(l.runDate)} · {methodLabel(l.paymentMethod)} {lineName(l)}
                    </span>
                    <span className="tabular-nums">
                      {l.lineTotal !== null ? formatMoney(l.lineTotal) : lineQty(l)}
                    </span>
                  </li>
                ),
              )}
            </FinanceGroupRow>
          ))}
        </ul>
      )}
    </div>
  );
}
