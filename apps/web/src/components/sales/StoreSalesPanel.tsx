/**
 * StoreSalesPanel — one store's sales today: the day's totals, the
 * "Record sale" form and the list of sales, in that order (M2.0c,
 * 2026-05-08).
 *
 * 2026-10-21 CA-09: shared by the Sales tab, the daily close page and
 * Admin → Stores → [store] → Sales; cashiers only get the daily close, so
 * before this they held sales.record but had nowhere to use it. Keep
 * behaviour changes here. The caller sets the outer padding (UI-12,
 * review CONF-24).
 *
 * Recording a sale deducts the dish's ingredients from inventory by its
 * recipe, on the server in the same transaction. A sale is voided with a
 * reason, never deleted; the server puts the ingredients back with
 * reversing ledger rows.
 *
 * `sales.record` in this store records and voids; anyone who can read the
 * store sees the list.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  FieldError,
  Input,
  LoadingState,
  NameCell,
  SectionLabel,
  Select,
  Sheet,
  cn,
  isWaitingOffline,
  rowGroupClass,
  useToast,
} from '@compass/ui';
import {
  SALES_LIST_CAP,
  SALE_QTY_MESSAGE,
  SALE_VOID_REASON_MAX,
  saleQtyProblem,
} from '@compass/contracts/limits';
import { newIdempotencyKey, trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useErrToast } from '../../hooks/useErrToast';
import { currencyOf, formatMoney, formatQty } from '../../lib/format';
import { useCanSeePrices, useStorePermission } from '../../hooks/useStorePermission';
import { useDateFormat, useI18n, useProductName, useProductNameParts } from '../../hooks/useI18n';
import { rowName } from '../../lib/productName';
import { normalizeVoidReason, salesListView } from './salesSummary';
import { moneyLine } from '../../lib/money';

/** The most stock items the below-zero warning names (review CONF-24). */
const NEGATIVE_NAMES_SHOWN = 3;

export function StoreSalesPanel({ storeId, className }: { storeId: string; className?: string }) {
  const dateFmt = useDateFormat();
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const productName = useProductName();
  const productNameParts = useProductNameParts();
  const utils = trpc.useUtils();
  const session = useAuthStore((s) => s.session);
  // Mirrors the server's requireSalesRecord (CA-10/CA-57: no users.manage
  // fallback). Review CONF-14: as it holds in this store, overrides
  // included; the flat set showed the form to someone denied here.
  const canRecord = useStorePermission('sales.record', storeId);

  // CLS-9 (2026-10-30): archived dishes too, so today's sales of a dish
  // archived since keep its name; the picker offers active ones only.
  // D6 (2026-10-31): selling prices and turnover only with prices.view in
  // this store; the server leaves them out too. CONF-24: each dish's
  // ingredient count, without the recipe rows (only "has a recipe" is
  // needed here).
  const canSeePrices = useCanSeePrices(storeId);
  const dishesQuery = trpc.dishes.list.useQuery({
    includeArchived: true,
    storeId,
    withIngredients: false,
  });
  const salesQuery = trpc.sales.list.useQuery({ storeId });
  // CONF-17: the day's totals come from the server, over every sale; the
  // list holds only the newest SALES_LIST_CAP.
  const summaryQuery = trpc.sales.summary.useQuery({ storeId });

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
    for (const d of dishesQuery.data?.dishes ?? []) {
      m.set(d.id, {
        id: d.id,
        names: d.names as Record<string, string>,
        unitPrice: d.unitPrice,
        ingredientCount: d.ingredientCount,
        isArchived: d.isArchived,
      });
    }
    return m;
  }, [dishesQuery.data]);

  const [draftDishId, setDraftDishId] = useState('');
  const [draftQty, setDraftQty] = useState('1');
  // CLS-11: 1.005 was sent as 1.00 and 0.001 as 0.00, then refused as
  // 「出错了」. CONF-24: the server's own rule, said under the field once
  // it was left or a record was tried (DX-VIS-15), not at the first digit.
  const qtyProblem = saleQtyProblem(draftQty);
  const [qtyRevealed, setQtyRevealed] = useState(false);
  const shownQtyProblem = qtyRevealed ? qtyProblem : null;
  const qtyRef = useRef<HTMLInputElement>(null);
  const qtyErrorId = useId();

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
    onSuccess: (data) => {
      recordIdemCtx.idempotencyKey = newIdempotencyKey();
      void utils.sales.list.invalidate({ storeId });
      void utils.sales.summary.invalidate({ storeId });
      // M2.0c: also invalidate inventory levels — consumption rows
      // just landed in the ledger.
      void utils.inventory.levels.invalidate({ storeId });
      // DX-SAL-1 (2026-11-01): the sale is kept, but stock it drove below
      // zero is said out loud — the toast used to read "stock deducted
      // automatically" for an apple nobody had ever received.
      // (`negativeStock` is absent from an older server's answer.)
      // CONF-24: at most NEGATIVE_NAMES_SHOWN names, then "and N more";
      // a long recipe filled the screen.
      const negative = (data.negativeStock ?? []).map((n) => productName({ names: n.names }));
      if (negative.length > 0) {
        const items = negative.slice(0, NEGATIVE_NAMES_SHOWN).join(i18n.t('common.listSeparator'));
        const more = negative.length - NEGATIVE_NAMES_SHOWN;
        toast.show(
          more > 0
            ? i18n.t('sales.toast.recordedNegativeMore', { items, n: more })
            : i18n.t('sales.toast.recordedNegative', { items }),
          { tone: 'warn', ttlMs: 8000 },
        );
      } else {
        toast.success(i18n.t('sales.toast.recorded'));
      }
      setDraftDishId('');
      setDraftQty('1');
      setQtyRevealed(false);
    },
    // sales.record takes an idempotency key (above), so the toast may
    // say that trying again is safe.
    onError: errToast('common.errors.actionFailed', { retrySafe: true }),
  });

  // 2026-10-21: void flow — the sale being voided + the typed reason.
  const [voidTarget, setVoidTarget] = useState<{ saleId: string; name: string } | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const voidSale = trpc.sales.void.useMutation({
    onSuccess: () => {
      void utils.sales.list.invalidate({ storeId });
      void utils.sales.summary.invalidate({ storeId });
      // Reversal rows just landed in the ledger.
      void utils.inventory.levels.invalidate({ storeId });
      void utils.inventory.recentMovements.invalidate({ storeId });
      toast.success(i18n.t('sales.toast.voided'));
      setVoidTarget(null);
      setVoidReason('');
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const normalizedVoidReason = normalizeVoidReason(voidReason);

  const sales = salesQuery.data ?? [];

  // Today's headline (servings + revenue), counted by the server over the
  // sales that stand (CONF-17). Not shown while it loads or after it
  // failed: never a made-up 0.
  const summary = summaryQuery.isError ? undefined : summaryQuery.data;

  // Sort dishes alphabetically for the picker.
  const dishOptions = useMemo(() => {
    const list = [...dishById.values()].filter((d) => !d.isArchived);
    return list.sort((a, b) =>
      productName({ names: a.names }).localeCompare(productName({ names: b.names }), i18n.locale),
    );
  }, [dishById, productName, i18n.locale]);
  // R2-INT-2 (2026-10-31): dishes without a recipe can't be sold; when that
  // is all there is, say so instead of "tap Record for the first sale".
  // Dishes belong to the organisation, so dishes.manage is not per store.
  const canManageDishes = session?.permissions.includes('dishes.manage') ?? false;
  const hasSellableDish = dishOptions.some((d) => d.ingredientCount > 0);
  const canRecordHere = canRecord && !dishesQuery.isLoading && hasSellableDish;
  const listView = salesListView({
    isLoading: salesQuery.isLoading,
    isError: salesQuery.isError,
    rowCount: sales.length,
    waitingOffline: salesQuery.data === undefined && salesQuery.fetchStatus === 'paused',
    // The record card shows the no-dishes / no-recipe reason.
    recordingBlocked: canRecord && dishesQuery.data !== undefined && !hasSellableDish,
  });
  // 2026-10-21 FE-01 / F4-03: an errored list must not read as "0 sales" —
  // hide the summary and lock record/void until the list is back, so a
  // cashier can't re-enter sales that already exist.
  const listErrored = listView === 'error' || listView === 'offline';

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* 2026-10-21 CA-09: sales.list returns at most SALES_LIST_CAP rows.
          The totals below count every sale (CONF-17); only the list is cut. */}
      {!listErrored && sales.length >= SALES_LIST_CAP ? (
        <Banner title={i18n.t('sales.list.capReached', { n: SALES_LIST_CAP })} />
      ) : null}
      {/* Today summary tile. CONF-11: the kit's Card, not its look typed
          again. */}
      {listErrored || !summary ? null : (
        <Card className={`grid ${canSeePrices ? 'grid-cols-2' : 'grid-cols-1'} gap-2 p-3`}>
          <div>
            <SectionLabel padded={false}>{i18n.t('sales.summary.today')}</SectionLabel>
            <div className="text-old-h2 font-semibold tabular-nums">
              {formatQty(summary.servings)}
            </div>
            {/* R2-COPY-5: the noun agrees with the big figure above it
                ("1 serving", «2 порции»). */}
            <div className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('sales.summary.servings', { n: Number(summary.servings) })}
            </div>
          </div>
          {canSeePrices ? (
            <div>
              <SectionLabel padded={false}>{i18n.t('sales.summary.revenue')}</SectionLabel>
              <div className="text-old-h2 font-semibold tabular-nums">
                {formatMoney(summary.revenue)}
              </div>
              <div className="text-old-label text-[var(--c-fg-muted)]">{currencyOf(session)}</div>
            </div>
          ) : null}
        </Card>
      )}

      {/* Record sale form. */}
      {canRecord ? (
        <Card className="flex flex-col gap-2 p-3">
          <SectionLabel padded={false}>{i18n.t('sales.form.recordTitle')}</SectionLabel>
          {/* 2026-10-21 F4-12: while dishes load, don't tell the cashier to
              go create dishes in the Catalog. */}
          {dishesQuery.isLoading ? (
            <LoadingState variant="inline" />
          ) : isWaitingOffline(dishesQuery) ? (
            // CLS-6: offline with no saved menu is not "no dishes yet".
            <p className="text-old-label text-[var(--c-fg-muted)]">{i18n.t('common.offlineNoData')}</p>
          ) : dishOptions.length === 0 ? (
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {/* CLS-21 (2026-10-30): the hint named an English path and was
                  shown to cashiers who cannot create dishes. */}
              {canManageDishes
                ? i18n.t('sales.form.noDishesYet')
                : i18n.t('sales.form.noDishesAskAdmin')}
            </p>
          ) : (
            <>
              {hasSellableDish ? null : (
                <p className="text-old-label text-[var(--c-fg-muted)]">
                  {canManageDishes
                    ? i18n.t('sales.form.noRecipeYet')
                    : i18n.t('sales.form.noRecipeAskAdmin')}
                </p>
              )}
              <Select
                value={draftDishId}
                disabled={listErrored}
                aria-label={i18n.t('sales.form.pickDish')}
                onChange={(e) => setDraftDishId(e.target.value)}
              >
                <option value="">{i18n.t('sales.form.pickDish')}</option>
                {dishOptions.map((d) => {
                  const name = productName({ names: d.names });
                  // R2-CLS-5: one template per language, so zh gets
                  // full-width brackets.
                  const label =
                    d.ingredientCount === 0
                      ? i18n.t('sales.form.dishNoRecipe', { name })
                      : name;
                  return (
                    <option key={d.id} value={d.id} disabled={d.ingredientCount === 0}>
                      {label}
                    </option>
                  );
                })}
              </Select>
              <div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    ref={qtyRef}
                    value={draftQty}
                    aria-label={i18n.t('sales.form.qtyLabel')}
                    invalid={shownQtyProblem !== null}
                    aria-describedby={shownQtyProblem ? qtyErrorId : undefined}
                    formatError="none"
                    className="flex-1"
                    disabled={listErrored}
                    onBlur={() => setQtyRevealed(true)}
                    onChange={(e) => setDraftQty(e.currentTarget.value)}
                  />
                  <Button
                    loading={record.isPending}
                    disabled={listErrored || !draftDishId}
                    onClick={() => {
                      if (listErrored || !draftDishId) return;
                      if (qtyProblem) {
                        setQtyRevealed(true);
                        qtyRef.current?.focus();
                        return;
                      }
                      record.mutate({ storeId, dishId: draftDishId, qty: draftQty.trim() });
                    }}
                  >
                    {i18n.t('sales.form.recordBtn')}
                  </Button>
                </div>
                {shownQtyProblem ? (
                  <FieldError id={qtyErrorId}>
                    {i18n.t(SALE_QTY_MESSAGE[shownQtyProblem])}
                  </FieldError>
                ) : null}
              </div>
            </>
          )}
        </Card>
      ) : null}

      {/* Today's sales list. */}
      <div>
        {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
        <SectionLabel className="mb-2 px-0">{i18n.t('sales.list.title')}</SectionLabel>
        {listView === 'loading' ? (
          <LoadingState variant="compact" />
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
        ) : listView === 'offline' ? (
          <EmptyState title={i18n.t('common.offlineNoData')} />
        ) : listView === 'none' ? null : listView === 'empty' ? (
          <EmptyState
            title={i18n.t('sales.empty.title')}
            description={canRecordHere ? i18n.t('sales.empty.description') : undefined}
          />
        ) : (
          // CONF-11 / UI-6: one card with rows divided by hairlines; each
          // sale was a card of its own.
          <ul className={rowGroupClass} role="list">
            {sales.map((sale) => {
              const dish = dishById.get(sale.dishId);
              // One line for the void sheet; two in the row (UI-4).
              const name = dish ? productName({ names: dish.names }) : i18n.t('common.unknownDish');
              // 2026-07-30: `undefined` meant "browser locale".
              const time = dateFmt.time(sale.occurredAt);
              const lineTotal =
                canSeePrices && sale.unitPrice && Number(sale.qty) > 0
                  ? moneyLine(sale.qty, sale.unitPrice)
                  : null;
              const voided = !!sale.voidedAt;
              return (
                // DX-SAL-4 (2026-11-01): a voided row is struck through,
                // not faded — 60 % opacity put the void reason at 2.6:1.
                // The strike stays on the dish and quantity; the reason
                // reads at full muted contrast.
                <li key={sale.id} className="flex items-baseline justify-between gap-2 px-3 py-2">
                  <div
                    className={`min-w-0 flex-1 ${voided ? 'text-[var(--c-fg-muted)] line-through' : ''}`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
                        {time}
                      </span>
                      <NameCell
                        {...rowName(productNameParts, dish, i18n.t('common.unknownDish'))}
                        primaryClassName={cn('font-medium', voided && 'text-[var(--c-fg-muted)]')}
                      />
                    </div>
                    {lineTotal !== null ? (
                      <div className="text-old-label text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} × {formatMoney(sale.unitPrice)} ={' '}
                        <span className="tabular-nums text-[var(--c-fg)]">
                          {formatMoney(lineTotal)}
                        </span>
                      </div>
                    ) : canSeePrices ? (
                      <div className="text-old-label text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} × —
                      </div>
                    ) : (
                      <div className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
                        {formatQty(sale.qty)} {i18n.t('sales.summary.servings', { n: Number(sale.qty) })}
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
                maxLength={SALE_VOID_REASON_MAX}
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
