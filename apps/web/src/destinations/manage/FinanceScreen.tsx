import { useMemo, useState } from 'react';
import { useToast } from '@compass/ui';
import { cn, Field, PaymentChip, Sheet } from '@compass/ui/kit';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useI18n, useProductName, useUnitLabel } from '../../hooks/useI18n';
import { currencyOf, formatMoney, formatQty } from '../../lib/format';
import { ChevronIcon, ClockIcon } from '../icons';

type Preset = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth' | 'custom';
type View = 'daily' | 'bySupplier' | 'byStore';
const PRESETS: Preset[] = ['today', 'yesterday', 'thisMonth', 'lastMonth', 'custom'];
const VIEWS: View[] = ['daily', 'bySupplier', 'byStore'];

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70 disabled:opacity-40';
const pick = (on: boolean) =>
  cn(CAPSULE, on ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink');

// The calendar day where the phone is. Not toISOString(): in Tashkent
// that is still yesterday until five in the morning.
function day(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function range(preset: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const now = new Date();
  if (preset === 'today') return { from: day(now), to: day(now) };
  if (preset === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { from: day(y), to: day(y) };
  }
  if (preset === 'thisMonth') {
    return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: day(now) };
  }
  return {
    from: day(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    to: day(new Date(now.getFullYear(), now.getMonth(), 0)),
  };
}

/**
 * What was spent over a period, and how it was paid: the figure an owner
 * checks against the cash box and the bank.
 *
 * One large total with its split into cash and transfer; the same
 * money then listed by day, by supplier or by store. A row opens to the
 * purchases behind it, in a sheet, where the old screen unfolded them
 * in place and pushed everything below off the screen.
 */
export function FinanceScreen() {
  const i18n = useI18n();
  const toast = useToast();
  const productName = useProductName();
  const unitLabel = useUnitLabel();
  const currency = currencyOf(useAuthStore((s) => s.session));

  const [preset, setPreset] = useState<Preset>('thisMonth');
  const [custom, setCustom] = useState(() => range('thisMonth'));
  const [view, setView] = useState<View>('daily');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { from, to } = preset === 'custom' ? custom : range(preset);
  const valid = !!from && !!to && from <= to;

  const lines = trpc.report.purchaseLines.useQuery(
    { startDate: from, endDate: to },
    { enabled: valid },
  );
  const totals = trpc.report.totals.useQuery({ startDate: from, endDate: to }, { enabled: valid });
  // Archived products too: a purchase keeps the name of what was bought.
  const skus = trpc.catalog.skus.useQuery({ includeArchived: true });
  const suppliers = trpc.admin.supplierList.useQuery();
  const stores = trpc.catalog.stores.useQuery({ permission: 'users.manage' });

  const skuById = useMemo(() => new Map((skus.data ?? []).map((s) => [s.id, s])), [skus.data]);
  const supplierName = (id: string | null) =>
    id
      ? (suppliers.data?.find((s) => s.id === id)?.name ?? id.slice(0, 8))
      : (i18n.t('finance.label.noSupplier') as string);
  const storeName = (id: string) =>
    stores.data?.find((s) => s.id === id)?.name.trim() || id.slice(0, 8);
  const skuName = (id: string) => {
    const sku = skuById.get(id);
    return sku ? productName({ names: sku.names as Record<string, string> }) : id.slice(0, 8);
  };

  const all = useMemo(() => lines.data ?? [], [lines.data]);
  const groups = useMemo(() => {
    const keyOf = (l: (typeof all)[number]) =>
      view === 'daily' ? l.runDate : view === 'bySupplier' ? (l.supplierId ?? '') : l.storeId;
    const byKey = new Map<
      string,
      { key: string; cash: number; transfer: number; lines: typeof all }
    >();
    for (const l of all) {
      const key = keyOf(l);
      const g = byKey.get(key) ?? { key, cash: 0, transfer: 0, lines: [] };
      if (l.paymentMethod === 'transfer') g.transfer += Number(l.lineTotal);
      else g.cash += Number(l.lineTotal);
      g.lines.push(l);
      byKey.set(key, g);
    }
    const list = [...byKey.values()];
    // Days newest first; suppliers and stores by what was spent.
    return view === 'daily'
      ? list.sort((a, b) => (a.key < b.key ? 1 : -1))
      : list.sort((a, b) => b.cash + b.transfer - (a.cash + a.transfer));
  }, [all, view]);
  const titleOf = (key: string) =>
    view === 'daily' ? key : view === 'bySupplier' ? supplierName(key || null) : storeName(key);
  const open = groups.find((g) => g.key === openKey) ?? null;

  const method = (m: string) =>
    i18n.t(m === 'transfer' ? 'run.label.paymentTransfer' : 'run.label.paymentCash') as string;
  const copy = () => {
    // Tab-separated, to paste into a spreadsheet.
    const text = [
      ['date', 'run', 'product', 'store', 'supplier', 'method', 'qty', 'unit_price', 'total'].join(
        '\t',
      ),
      ...all.map((l) =>
        [
          l.runDate,
          `#${l.runIndex + 1}`,
          skuName(l.skuId),
          storeName(l.storeId),
          l.supplierId ? supplierName(l.supplierId) : '',
          l.paymentMethod,
          l.qty,
          l.unitPrice,
          l.lineTotal,
        ].join('\t'),
      ),
    ].join('\n');
    if (!navigator.clipboard) {
      toast.error(i18n.t('finance.export.noClipboard'));
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => toast.success(i18n.t('finance.export.copied')),
      () => toast.error(i18n.t('finance.export.noClipboard')),
    );
  };

  return (
    <div className="flex flex-col gap-xl px-page">
      <div className="flex flex-col gap-md">
        <div className="-mx-page flex gap-sm overflow-x-auto px-page">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={preset === p}
              data-testid="finance-period"
              onClick={() => {
                // Custom starts from the dates being looked at.
                if (p === 'custom') setCustom({ from, to });
                setPreset(p);
              }}
              className={pick(preset === p)}
            >
              {i18n.t(`finance.preset.${p}`)}
            </button>
          ))}
        </div>
        {preset === 'custom' ? (
          <div className="grid grid-cols-2 gap-md">
            <Field
              type="date"
              label={i18n.t('finance.range.start') as string}
              value={custom.from}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
            />
            <Field
              type="date"
              label={i18n.t('finance.range.end') as string}
              value={custom.to}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
            />
          </div>
        ) : (
          <p className="text-small text-secondary" dir="ltr">
            {from === to ? from : `${from} – ${to}`}
          </p>
        )}
      </div>

      {totals.data ? (
        <div data-testid="finance-total" className="flex flex-col gap-xs">
          <span className="text-small text-secondary">{i18n.t('finance.label.total')}</span>
          <span className="flex flex-wrap items-baseline gap-x-sm text-ink" dir="ltr">
            <span className="text-display tabular-nums">{formatMoney(totals.data.total)}</span>
            <span className="text-label text-secondary">{currency}</span>
          </span>
          <span className="text-small text-secondary">
            {i18n.t('run.label.paymentCash')}{' '}
            <span dir="ltr" className="tabular-nums text-ink">
              {formatMoney(totals.data.totalCash)}
            </span>
            {' · '}
            {i18n.t('run.label.paymentTransfer')}{' '}
            <span dir="ltr" className="tabular-nums text-ink">
              {formatMoney(totals.data.totalTransfer)}
            </span>
          </span>
          <span className="text-small text-secondary">
            {totals.data.runCount} {i18n.t('finance.label.runs')}
            {' · '}
            {totals.data.cashLines + totals.data.transferLines} {i18n.t('finance.label.lines')}
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-lg">
        <div className="-mx-page flex gap-sm overflow-x-auto px-page">
          {VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              data-testid="finance-view"
              onClick={() => {
                setView(v);
                setOpenKey(null);
              }}
              className={pick(view === v)}
            >
              {i18n.t(`finance.view.${v}`)}
            </button>
          ))}
          <button
            type="button"
            data-testid="finance-copy"
            disabled={all.length === 0}
            onClick={copy}
            className={cn(CAPSULE, 'bg-surface-sunken text-ink')}
          >
            {i18n.t('finance.export.label')}
          </button>
        </div>

        {!valid ? (
          <p className="text-body text-danger">{i18n.t('run.history.invalidDateRange')}</p>
        ) : lines.isPending ? (
          <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
        ) : lines.isError ? (
          <p className="text-body text-danger">{i18n.t('common.error')}</p>
        ) : groups.length === 0 ? (
          <div className="flex items-center gap-lg">
            <span
              aria-hidden
              className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
            >
              <ClockIcon />
            </span>
            <span className="min-w-0">
              <span className="block text-label text-secondary">
                {i18n.t('finance.empty.title')}
              </span>
              <span className="block text-small text-secondary">
                {i18n.t('finance.empty.description')}
              </span>
            </span>
          </div>
        ) : (
          <ul className="flex flex-col">
            {groups.map((g) => (
              <li key={g.key || 'none'}>
                <button
                  type="button"
                  data-testid="finance-row"
                  onClick={() => setOpenKey(g.key)}
                  className="flex min-h-row w-full items-center gap-lg py-sm text-start outline-none active:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-label text-ink">{titleOf(g.key)}</span>
                    <span className="block text-small text-secondary">
                      {[
                        g.cash > 0
                          ? `${i18n.t('run.label.paymentCash')} ${formatMoney(g.cash)}`
                          : null,
                        g.transfer > 0
                          ? `${i18n.t('run.label.paymentTransfer')} ${formatMoney(g.transfer)}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-money tabular-nums text-ink" dir="ltr">
                    {formatMoney(g.cash + g.transfer)}
                  </span>
                  <span className="shrink-0 text-forest">
                    <ChevronIcon />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Sheet
        open={!!open}
        onOpenChange={(next) => !next && setOpenKey(null)}
        title={open ? titleOf(open.key) : ''}
      >
        {open ? (
          <div className="flex flex-col gap-lg">
            <span className="flex flex-wrap items-baseline gap-x-sm text-ink" dir="ltr">
              <span className="text-display tabular-nums">
                {formatMoney(open.cash + open.transfer)}
              </span>
              <span className="text-label text-secondary">{currency}</span>
            </span>
            <ul className="flex flex-col">
              {open.lines.map((l, index) => (
                <li
                  key={`${l.runId}-${l.skuId}-${l.storeId}-${index}`}
                  data-testid="finance-line"
                  className="flex min-h-row items-center gap-lg py-sm"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-label text-ink">{skuName(l.skuId)}</span>
                    <span className="block text-small text-secondary" dir="ltr">
                      {formatQty(l.qty)} {unitLabel(skuById.get(l.skuId)?.unit)} ×{' '}
                      {formatMoney(l.unitPrice)}
                    </span>
                    <span className="block text-small text-secondary">
                      {[
                        view === 'daily' ? null : l.runDate,
                        view === 'byStore' ? null : storeName(l.storeId),
                        view === 'bySupplier' || !l.supplierId ? null : supplierName(l.supplierId),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-xs">
                    <span className="text-money tabular-nums text-ink" dir="ltr">
                      {formatMoney(l.lineTotal)}
                    </span>
                    <PaymentChip
                      method={l.paymentMethod === 'transfer' ? 'transfer' : 'cash'}
                      label={method(l.paymentMethod)}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
