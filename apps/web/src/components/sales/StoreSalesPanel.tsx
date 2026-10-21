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
import { Banner, Button, EmptyState, Input, SectionLabel, Spinner, useToast } from '@compass/ui';
import { newIdempotencyKey, trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useErrToast } from '../../lib/errToast';
import { formatMoney, formatQty } from '../../lib/format';
import { useDateFormat, useI18n, useProductName } from '../../hooks/useI18n';

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

  const dishesQuery = trpc.dishes.list.useQuery({ includeArchived: false });
  const salesQuery = trpc.sales.list.useQuery({ storeId });

  const dishById = useMemo(() => {
    const m = new Map<
      string,
      {
        id: string;
        names: Record<string, string>;
        unitPrice: string | null;
        ingredientCount: number;
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

  const sales = salesQuery.data ?? [];

  // Compute today's headline (revenue + count) for the summary row.
  const summary = useMemo(() => {
    let count = 0;
    let revenue = 0;
    for (const s2 of sales) {
      const qty = Number(s2.qty);
      count += qty;
      if (s2.unitPrice) revenue += qty * Number(s2.unitPrice);
    }
    return { count, revenue };
  }, [sales]);

  // Sort dishes alphabetically for the picker.
  const dishOptions = useMemo(() => {
    const list = [...dishById.values()];
    return list.sort((a, b) =>
      productName({ names: a.names }).localeCompare(productName({ names: b.names })),
    );
  }, [dishById, productName]);

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* 2026-10-21 CA-09: sales.list returns at most SALES_LIST_CAP rows,
          so on a busy day the summary below undercounts — say so. */}
      {sales.length >= SALES_LIST_CAP ? (
        <Banner tone="warn" title={i18n.t('sales.list.capReached', { n: SALES_LIST_CAP })} />
      ) : null}
      {/* Today summary tile. */}
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

      {/* Record sale form. */}
      {canRecord ? (
        <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 ring-hairline">
          {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
          <SectionLabel className="px-0 py-0">{i18n.t('sales.form.recordTitle')}</SectionLabel>
          {dishOptions.length === 0 ? (
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('sales.form.noDishesYet')}
            </p>
          ) : (
            <>
              <select
                className="h-10 w-full rounded-[var(--r-pill)] bg-[var(--c-surface)] px-3 text-old-body ring-hairline"
                value={draftDishId}
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
                />
                <Button
                  loading={record.isPending}
                  disabled={!draftDishId || Number(draftQty) <= 0}
                  onClick={() => {
                    if (!draftDishId || Number(draftQty) <= 0) return;
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
        {salesQuery.isLoading ? (
          <div className="py-4 text-center">
            <Spinner size={16} />
          </div>
        ) : sales.length === 0 ? (
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
              return (
                <li
                  key={sale.id}
                  className="flex items-baseline justify-between gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline"
                >
                  <div className="min-w-0 flex-1">
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
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
