/**
 * StoreSalesPanel — today's sales + "Record sale" form for one store.
 *
 * 2026-10-21 CA-09: extracted verbatim from Admin → Stores → [store] →
 * Sales (StoreSalesTab in StoresSections.tsx) so the Settlement page can
 * render the same surface. Cashiers only get the Settlement tab, so
 * before this they held sales.record but had nowhere to use it.
 * Both call sites render this component; keep behaviour changes here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  Sheet,
  Spinner,
  useToast,
} from '@compass/ui';
import { newIdempotencyKey, trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useErrToast } from '../../lib/errToast';
import { formatMoney, formatQty } from '../../lib/format';
import { useDateFormat, useI18n, useProductName } from '../../hooks/useI18n';
import { normalizeVoidReason, salesListView, summarizeSales } from './salesSummary';

/** Server-side row cap of `sales.list` (apps/api/src/trpc/routers/sales.ts). */
export const SALES_LIST_CAP = 200;

/**
 * StoreSalesPanel (M2.0c, 2026-05-08; extracted 2026-10-21 CA-09).
 *
 * Sales recording surface for a single store. Closes the ERP loop —
 * each sale auto-deducts ingredient inventory via the dish's recipe
 * BOM (server-side, same transaction). Two zones:
 *
 *   - Today's list (top): every sale recorded today, newest first,
 *     showing time + dish + qty + line revenue if priced.
 *   - "Record sale" entry (bottom): dish picker + qty input. Tap
 *     Save → tRPC roundtrip, list refreshes.
 *
 * Permissions:
 *   - `sales.record` (per-store) for the Save action. Granted by
 *     default to manager, cashier + staff roles.
 *   - Anyone with read access to the store can see the list.
 *   - 2026-10-21: `sales.record` also gates Void (sales.void) — a sale
 *     is voided with a reason, never deleted; the server puts the
 *     ingredients back with reversing ledger rows.
 */
export function StoreSalesPanel({
  storeId,
  className = 'px-4 py-3',
}: {
  storeId: string;
  /** Outer padding. The admin tab pads itself; Settlement nests it in a
   *  section that already has the page gutter. */
  className?: string;
}) {
  const dateFmt = useDateFormat();
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const productName = useProductName();
  const utils = trpc.useUtils();
  const session = useAuthStore((s) => s.session);
  // 2026-10-21 CA-10/CA-57: mirrors the server's requireSalesRecord,
  // which no longer accepts users.manage as a fallback (migration 0048
  // backfilled the built-in grants). A store-level deny still surfaces
  // as a 403 toast — the flat session set can't see per-store overrides.
  const canRecord = session?.permissions.includes('sales.record') ?? false;

  // CLS-9 (2026-10-30): archived dishes too, so today's sales of a dish
  // archived since keep its name; the picker offers active ones only.
  const dishesQuery = trpc.dishes.list.useQuery({ includeArchived: true });
  const salesQuery = trpc.sales.list.useQuery({ storeId });

  const dishById = useMemo(() => {
    const m = new Map<
      string,
      {
        id: string;
        names: Record<string, string>;
        unitPrice: string | null;
        ingredientCount: number;
        isArchived: boolean;
      }
    >();
    const ingCount = new Map<string, number>();
    for (const ing of dishesQuery.data?.ingredients ?? []) {
      ingCount.set(ing.dishId, (ingCount.get(ing.dishId) ?? 0) + 1);
    }
    for (const d of dishesQuery.data?.dishes ?? []) {
      m.set(d.id, {
        id: d.id,
        names: d.names as Record<string, string>,
        unitPrice: d.unitPrice,
        ingredientCount: ingCount.get(d.id) ?? 0,
        isArchived: d.isArchived,
      });
    }
    return m;
  }, [dishesQuery.data]);

  const [draftDishId, setDraftDishId] = useState('');
  const [draftQty, setDraftQty] = useState('1');

  // 2026-10-21 audit CA-21 (D-09): one stable idempotency key per
  // logical sale. Minted whenever the form is (re)armed — any edit of
  // dish/qty is a different sale — reused when the same submit is
  // retried (e.g. after an iOS "Load failed" whose request DID commit,
  // so the server replays instead of deducting stock twice), and
  // rotated after success. Sharing one ref is safe: the button is
  // `loading` while a record is in flight.
  const recordIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  useEffect(() => {
    recordIdemCtx.idempotencyKey = newIdempotencyKey();
  }, [recordIdemCtx, draftDishId, draftQty]);

  const record = trpc.sales.record.useMutation({
    trpc: { context: recordIdemCtx },
    onSuccess: () => {
      recordIdemCtx.idempotencyKey = newIdempotencyKey();
      void utils.sales.list.invalidate({ storeId });
      // M2.0c: also invalidate inventory levels — consumption rows
      // just landed in the ledger.
      void utils.inventory.levels.invalidate({ storeId });
      toast.success(i18n.t('sales.toast.recorded'));
      setDraftDishId('');
      setDraftQty('1');
    },
    onError: errToast('common.error'),
  });

  // 2026-10-21: void flow — the sale being voided + the typed reason.
  const [voidTarget, setVoidTarget] = useState<{ saleId: string; name: string } | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const voidSale = trpc.sales.void.useMutation({
    onSuccess: () => {
      void utils.sales.list.invalidate({ storeId });
      // Reversal rows just landed in the ledger.
      void utils.inventory.levels.invalidate({ storeId });
      void utils.inventory.recentMovements.invalidate({ storeId });
      toast.success(i18n.t('sales.toast.voided'));
      setVoidTarget(null);
      setVoidReason('');
    },
    onError: errToast('common.error'),
  });
  const normalizedVoidReason = normalizeVoidReason(voidReason);

  const sales = salesQuery.data ?? [];
  // 2026-10-21 FE-01 / F4-03: an errored list must not read as "0 sales" —
  // hide the summary and lock record/void until the list is back, so a
  // cashier can't re-enter sales that already exist.
  const listView = salesListView({
    isLoading: salesQuery.isLoading,
    isError: salesQuery.isError,
    rowCount: sales.length,
  });
  const listErrored = listView === 'error';

  // Compute today's headline (revenue + count) for the summary row.
  // 2026-10-21: voided sales don't count (see salesSummary.ts).
  const summary = useMemo(() => summarizeSales(sales), [sales]);

  // Sort dishes alphabetically for the picker.
  const dishOptions = useMemo(() => {
    const list = [...dishById.values()].filter((d) => !d.isArchived);
    return list.sort((a, b) =>
      productName({ names: a.names }).localeCompare(productName({ names: b.names })),
    );
  }, [dishById, productName]);

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* 2026-10-21 CA-09: sales.list returns at most SALES_LIST_CAP rows,
          so on a busy day the summary below undercounts — say so. */}
      {!listErrored && sales.length >= SALES_LIST_CAP ? (
        <Banner tone="warn" title={i18n.t('sales.list.capReached', { n: SALES_LIST_CAP })} />
      ) : null}
      {/* Today summary tile. */}
      {listErrored ? null : (
        <div className="grid grid-cols-2 gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
          <div>
            <SectionLabel padded={false}>{i18n.t('sales.summary.today')}</SectionLabel>
            <div className="font-mono text-old-h2 font-semibold tabular-nums">
              {formatQty(summary.count.toString())}
            </div>
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('sales.summary.servings')}
            </div>
          </div>
          <div>
            <SectionLabel padded={false}>{i18n.t('sales.summary.revenue')}</SectionLabel>
            <div className="font-mono text-old-h2 font-semibold tabular-nums">
              {formatMoney(summary.revenue)}
            </div>
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {session?.member.currency ?? 'UZS'}
            </div>
          </div>
        </div>
      )}

      {/* Record sale form. */}
      {canRecord ? (
        <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
          {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
          <SectionLabel className="px-0 py-0">{i18n.t('sales.form.recordTitle')}</SectionLabel>
          {/* 2026-10-21 F4-12: while dishes load, don't tell the cashier to
              go create dishes in the Catalog. */}
          {dishesQuery.isLoading ? (
            <div className="py-2 text-center">
              <Spinner size={16} />
            </div>
          ) : dishOptions.length === 0 ? (
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('sales.form.noDishesYet')}
            </p>
          ) : (
            <>
              <select
                className="h-10 w-full rounded-[var(--r-pill)] bg-[var(--c-surface)] px-3 text-old-body ring-hairline disabled:opacity-60"
                value={draftDishId}
                disabled={listErrored}
                onChange={(e) => setDraftDishId(e.target.value)}
              >
                <option value="">{i18n.t('sales.form.pickDish')}</option>
                {dishOptions.map((d) => {
                  const label = productName({ names: d.names });
                  const suffix =
                    d.ingredientCount === 0 ? ` (${i18n.t('sales.form.noRecipe')})` : '';
                  return (
                    <option key={d.id} value={d.id} disabled={d.ingredientCount === 0}>
                      {label}
                      {suffix}
                    </option>
                  );
                })}
              </select>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="1"
                  min="1"
                  value={draftQty}
                  onChange={(e) => setDraftQty(e.target.value)}
                  aria-label={i18n.t('sales.form.qtyLabel')}
                  className="flex-1"
                  disabled={listErrored}
                />
                <Button
                  loading={record.isPending}
                  disabled={listErrored || !draftDishId || Number(draftQty) <= 0}
                  onClick={() => {
                    if (listErrored || !draftDishId || Number(draftQty) <= 0) return;
                    record.mutate({
                      storeId,
                      dishId: draftDishId,
                      qty: Number(draftQty).toFixed(2),
                    });
                  }}
                >
                  {i18n.t('sales.form.recordBtn')}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* Today's sales list. */}
      <div>
        {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
        <SectionLabel className="mb-2 px-0">{i18n.t('sales.list.title')}</SectionLabel>
        {listView === 'loading' ? (
          <div className="py-4 text-center">
            <Spinner size={16} />
          </div>
        ) : listView === 'error' ? (
          <Banner
            tone="danger"
            title={i18n.t('common.error')}
            action={
              <Button
                variant="pearl"
                size="sm"
                loading={salesQuery.isFetching}
                onClick={() => void salesQuery.refetch()}
              >
                {i18n.t('common.retry')}
              </Button>
            }
          />
        ) : listView === 'empty' ? (
          <EmptyState
            title={i18n.t('sales.empty.title')}
            description={i18n.t('sales.empty.description')}
          />
        ) : (
          <ul className="flex flex-col gap-1" role="list">
            {sales.map((sale) => {
              const dish = dishById.get(sale.dishId);
              const name = dish ? productName({ names: dish.names }) : sale.dishId.slice(0, 8);
              // 2026-07-30: `undefined` meant "browser locale".
              const time = dateFmt.time(sale.occurredAt);
              const lineTotal =
                sale.unitPrice && Number(sale.qty) > 0
                  ? Number(sale.qty) * Number(sale.unitPrice)
                  : null;
              const voided = !!sale.voidedAt;
              return (
                <li
                  key={sale.id}
                  className={
                    'flex items-baseline justify-between gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline ' +
                    (voided ? 'opacity-60' : '')
                  }
                >
                  <div className={`min-w-0 flex-1 ${voided ? 'line-through' : ''}`}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
                        {time}
                      </span>
                      <span className="truncate text-old-body font-medium">{name}</span>
                    </div>
                    {lineTotal !== null ? (
                      <div className="text-old-label text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} × {formatMoney(sale.unitPrice)} ={' '}
                        <span className="font-mono tabular-nums text-[var(--c-fg)]">
                          {formatMoney(lineTotal)}
                        </span>
                      </div>
                    ) : (
                      <div className="text-old-label text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} × —
                      </div>
                    )}
                  </div>
                  {voided ? (
                    <div className="max-w-[45%] text-right text-old-label text-[var(--c-fg-muted)]">
                      {i18n.t('sales.void.voidedLabel', { reason: sale.voidReason ?? '' })}
                    </div>
                  ) : canRecord ? (
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => {
                        setVoidReason('');
                        setVoidTarget({ saleId: sale.id, name });
                      }}
                    >
                      {i18n.t('sales.action.void')}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 2026-10-21: void confirmation — a reason is mandatory. */}
      <Sheet
        open={voidTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setVoidTarget(null);
            setVoidReason('');
          }
        }}
        title={i18n.t('sales.void.title')}
        description={voidTarget ? i18n.t('sales.void.description', { dish: voidTarget.name }) : ''}
        footer={
          voidTarget ? (
            <Button
              block
              variant="danger"
              loading={voidSale.isPending}
              disabled={listErrored || !normalizedVoidReason}
              onClick={() => {
                if (listErrored || !voidTarget || !normalizedVoidReason) return;
                voidSale.mutate({ saleId: voidTarget.saleId, reason: normalizedVoidReason });
              }}
            >
              {i18n.t('sales.void.confirmBtn')}
            </Button>
          ) : null
        }
      >
        {voidTarget ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label={i18n.t('sales.void.reasonLabel')}>
              <Input
                value={voidReason}
                maxLength={300}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder={i18n.t('sales.void.reasonPlaceholder')}
                autoFocus
              />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
