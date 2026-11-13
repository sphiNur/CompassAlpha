import { useMemo, useState } from 'react';
import {
  Banner,
  Button,
  ChipBar,
  Chip,
  cn,
  DataState,
  EmptyState,
  SearchInput,
  SectionLabel,
  Sheet,
  StickyPageBar,
} from '@compass/ui';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton } from '../hooks/usePageMainButton';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { errorTextOf } from '../lib/errorText';
import { PendingSyncNotice } from '../components/PendingSyncNotice';
import { pendingChangeCount } from '../lib/pendingChanges';
import { refetchFailedQueries } from '../hooks/useRefetchFailedOnReconnect';
import {
  useDateFormat,
  useI18n,
  useProductName,
  useProductNameParts,
  useUnitLabel,
} from '../hooks/useI18n';
import { useCurrency } from '../hooks/useCurrency';
import { StoreContextEmpty } from '../components/NoStoreYet';
import { useStoreContext } from '../hooks/useStoreContext';
import { sentBatchCount } from './order/batchCount';
import { orderableSkus } from './order/catalogGroups';
import { repeatOrderFill } from './order/repeatOrder';
import { sessionLoadState } from './order/sessionLoadState';
import { otherRejectedBatch } from './order/batchStatus';
import { BatchReceipt } from './order/BatchReceipt';
import { BatchStrip } from './order/BatchStrip';
import { OrderStatusBanner, RejectedBatchNotice } from './order/OrderStatusBanner';
import { ReviewList } from './order/ReviewList';
import { SessionExtrasEditor } from './order/SessionExtrasEditor';
import { SkuRow } from './order/SkuRow';
import { useAdjustQueue } from './order/useAdjustQueue';
import { useBatchView } from './order/useBatchView';
import { useCatalogFilter } from './order/useCatalogFilter';
import { useExtrasSave } from './order/useExtrasSave';
import { useSubmitBatch } from './order/useSubmitBatch';

/**
 * The order page: a store's catalog to order from, today's batches, and
 * the receipt of a sent one.
 *
 * Review ORD-10 (2026-11, step 2): the page composes. Its pipelines and
 * its state machine live in hooks next to it, one per concern —
 * useBatchView (which batch is shown, new batch, a batch opened from
 * today's list), useAdjustQueue (quantity writes), useExtrasSave (other
 * items), useSubmitBatch (send / take back), useCatalogFilter (search and
 * category) — and a sent batch is one BatchReceipt, its status one
 * OrderStatusBanner.
 */
export function OrderPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const productNameParts = useProductNameParts();
  // 2026-07-30 (flow review): the Order surface was the ONE place still
  // rendering the raw canonical unit ("kg" / "pcs") while Approval, Run
  // and the extras editor all went through useUnitLabel. Staff saw
  // "0.5 kg" here and "0.5 公斤" on every downstream screen. Memoized by
  // locale, so passing it into the React.memo'd SkuRow is memo-safe.
  const unitLabel = useUnitLabel();
  const dateFmt = useDateFormat();
  const session = useAuthStore((s) => s.session);
  const orgCurrency = useCurrency();
  // COREWEB2-21: an order is dated on the org's calendar, not the phone's.
  const orgTimeZone = session?.member.timezone;
  // OrderPage requires a SPECIFIC store — you can't draft an order
  // without a target. If the global store-switcher is on 'ALL', we
  // refuse and prompt the user to pick (added 2026-05-05).
  const storeCtx = useStoreContext();
  const currentStoreId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const [reviewOpen, setReviewOpen] = useState(false);
  // 2026-07-30: BatchStrip was written but never rendered, so the
  // "今日 N 批" count in the sticky bar was a dead number -- it told you
  // other batches existed and gave you no way to look at them. Now the
  // count is a button that opens this sheet, and the receipt view renders
  // the same strip inline.
  const [batchesOpen, setBatchesOpen] = useState(false);

  const categoriesQuery = trpc.catalog.categories.useQuery();
  // CAT-7 (2026-10-30): include archived products so lines already ordered,
  // approved or bought still show their name and unit (they showed as an id
  // fragment, or not at all). Pickers filter archived ones out.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  const {
    sessionQuery,
    batchesQuery,
    sessionStatus,
    isReadOnly,
    newBatchRef,
    startNewBatch,
    canLeaveNewBatch,
    leaveNewBatch,
    otherBatch,
    openBatch,
    closeOtherBatch,
    showSent,
  } = useBatchView(currentStoreId);

  const queryClient = useQueryClient();
  // The offline outbox. Its replay (and the "did not sync" toast) lives at
  // app level now (CMP-FE-3, hooks/useOutboxReplay.ts).
  const offline = useOfflineQueue();
  const { handleQtyChange, flushAllPendingAdjusts, serializeOnStore } = useAdjustQueue({
    memberId: session?.member.memberId,
    orgTimeZone,
    newBatchRef,
    sendQueued: offline.sendQueued,
  });
  const saveExtras = useExtrasSave({
    storeId: currentStoreId,
    orgTimeZone,
    sendQueued: offline.sendQueued,
    serializeOnStore,
  });

  const allSkus = useMemo(() => skusQuery.data ?? [], [skusQuery.data]);

  const items = useMemo(() => sessionQuery.data?.items ?? [], [sessionQuery.data]);
  const totals = useMemo(() => sessionQuery.data?.totals ?? [], [sessionQuery.data]);
  const myMemberId = session?.member.memberId ?? null;

  /** Aggregate qty per SKU (sum across all contributors). For the header. */
  const totalQtyBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of totals) m.set(t.skuId, Number(t.qty));
    return m;
  }, [totals]);

  /** MY contribution per SKU. The +/- always edits this row. */
  const myQtyBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      if (it.contributorMemberId === myMemberId) m.set(it.skuId, Number(it.qty));
    }
    return m;
  }, [items, myMemberId]);

  // The catalogue offers active products, plus (DX-ORD-16) archived ones
  // still in my draft, so the line can be seen and taken out.
  const skus = useMemo(() => orderableSkus(allSkus, myQtyBySku), [allSkus, myQtyBySku]);
  const {
    searchQuery,
    setSearchQuery,
    deferredSearch,
    activeCategory,
    setActiveCategory,
    showAll,
    filteredSkus,
    catalogGroups,
    categoryNameById,
  } = useCatalogFilter({
    skus,
    categories: categoriesQuery.data,
    loaded: !!skusQuery.data,
  });

  /** All non-zero contributor rows per SKU — for the "added by N people" hint. */
  const contributorsBySku = useMemo(() => {
    const m = new Map<string, Array<{ memberId: string; qty: string }>>();
    for (const it of items) {
      if (Number(it.qty) <= 0) continue;
      const arr = m.get(it.skuId) ?? [];
      arr.push({ memberId: it.contributorMemberId, qty: it.qty });
      m.set(it.skuId, arr);
    }
    return m;
  }, [items]);

  // Distinct SKUs with non-zero aggregate qty, plus saved extras rows —
  // 2026-10-21 audit CA-27: the domain accepts an extras-only submit
  // (M3.33), but zeroing the last SKU used to hide Submit even with
  // extras on the session.
  const extrasCount = sessionQuery.data?.extras?.length ?? 0;
  const selectedCount = totals.length + extrasCount;

  // 2026-10-21 audit CA-27: the extras editor no longer waits for a SKU
  // tap to create the session. With no session yet it saves by
  // {storeId, date} and the server lazy-creates the draft (useExtrasSave);
  // the editor then adopts the real id without dropping the rows on screen.
  const extrasSessionId =
    sessionQuery.data && sessionQuery.data.id !== 'optimistic' ? sessionQuery.data.id : null;
  const showExtrasEditor =
    !!currentStoreId && (extrasSessionId !== null || (!isReadOnly && sessionQuery.isSuccess));

  // UX-02 (2026-11-13): an empty draft offers the last sent order's lines,
  // set through the same write a + tap makes (outbox, debounced, per
  // store), so they can be changed before Submit. Nothing is submitted.
  // Asked for only while the draft is empty.
  const draftEmpty =
    !!currentStoreId && !isReadOnly && sessionQuery.isSuccess && selectedCount === 0;
  const lastSubmittedQuery = trpc.order.lastSubmitted.useQuery(
    { storeId: currentStoreId ?? '' },
    { enabled: draftEmpty },
  );
  const repeatFill = useMemo(
    () => repeatOrderFill(lastSubmittedQuery.data?.lines ?? [], allSkus),
    [lastSubmittedQuery.data, allSkus],
  );
  const repeatLastOrder = () => {
    if (!currentStoreId) return;
    for (const line of repeatFill) handleQtyChange(currentStoreId, line.skuId, line.qty);
  };

  // The page's main button submits (simplification O1, 2026-11-13: one
  // tap, owner approved). It used to open the review sheet, and Submit
  // was a second tap inside it. The sheet stays as an optional look
  // ("View order" under the list, with its own Submit), and a sent batch
  // can be taken back from the toast or the receipt's banner (Withdraw).
  const canSubmit = sessionStatus === 'draft' || sessionStatus === 'rejected';
  const { submit, withdraw, handleSubmit } = useSubmitBatch({
    storeId: currentStoreId,
    canSubmit,
    selectedCount,
    flushAllPendingAdjusts,
    offline,
    onSubmitted: (sessionId) => {
      showSent(sessionId);
      setReviewOpen(false);
    },
    onWithdrawn: closeOtherBatch,
  });
  // 2026-10-21 FE-01: todaySession failed with nothing cached — we do not
  // know whether this member already submitted, so no catalog, no submit.
  const sessionLoad = sessionLoadState({
    isError: sessionQuery.isError,
    hasData: sessionQuery.data !== undefined,
    isNetworkError: isLikelyNetworkError(sessionQuery.error),
    waitingOffline: sessionQuery.fetchStatus === 'paused',
  });
  const sessionBlocked = sessionLoad === 'blocked';

  const mainButtonText = submit.isPending
    ? i18n.t('order.action.submitting')
    : i18n.t('order.action.submitCount', { n: selectedCount });

  const viewingOtherBatch = otherBatch !== null;
  usePageMainButton(
    mainButtonText,
    () => {
      if (!canSubmit || selectedCount === 0 || submit.isPending || viewingOtherBatch) return;
      if (!sessionQuery.data) return;
      // Offline, handleSubmit says that submitting needs a network.
      void handleSubmit();
    },
    {
      // RE-ORD-1 (2026-10-30): while another batch is shown read-only the
      // button would still act on the current draft — tapping it submitted
      // a batch the user was not looking at. No main button there.
      visible: canSubmit && selectedCount > 0 && !sessionBlocked && !viewingOtherBatch,
      active: selectedCount > 0 && !submit.isPending && !sessionBlocked,
    },
  );

  if (!session) return null;
  // An order is one store's: no store, or all of them, says why.
  if (!currentStoreId) return <StoreContextEmpty />;

  if (sessionLoad === 'offline') {
    return (
      <div className="flex flex-col px-4 pt-3">
        <EmptyState title={i18n.t('common.offlineNoData')} />
      </div>
    );
  }

  // 2026-10-21 FE-01: an errored todaySession used to fall through to an
  // empty, editable catalog (first tap lazily creates a NEW draft), so a
  // member who already submitted could order twice. Block until it loads.
  if (sessionBlocked) {
    return (
      <div className="flex flex-col px-4 pt-3">
        <Banner
          tone="danger"
          title={i18n.t('common.error')}
          action={
            <Button
              size="sm"
              variant="pearl"
              loading={sessionQuery.isFetching}
              onClick={() => void refetchFailedQueries(queryClient)}
            >
              {i18n.t('common.retry')}
            </Button>
          }
        >
          {/* RE-AUTH-5 (2026-10-30): showed the raw transport text, e.g.
              "Failed to fetch (session refresh did not complete)". */}
          {(() => {
            const said = errorTextOf(sessionQuery.error, 'common.errorUnknown');
            return i18n.t(said.key, said.vars);
          })()}
        </Banner>
      </div>
    );
  }
  // Background refetch failed but cached data is still good: keep the page
  // working and say so quietly.
  const staleWarning =
    sessionLoad === 'staleWarning' ? (
      <div className="px-4 pt-2">
        <Banner
          tone="warn"
          title={i18n.t('common.error')}
          action={
            <Button
              size="sm"
              variant="pearl"
              loading={sessionQuery.isFetching}
              onClick={() => void refetchFailedQueries(queryClient)}
            >
              {i18n.t('common.retry')}
            </Button>
          }
        />
      </div>
    ) : null;

  // 2026-07-30 (flow review): was `toLocaleDateString(undefined, …)`, i.e.
  // the BROWSER's locale, so the review sheet's subtitle read
  // "Thursday, July 30" above a Chinese item list.
  const dateLabel = dateFmt.weekdayLong(new Date());

  /** Open a batch from the day's list (the default one closes the view). */
  const selectBatch = (id: string) => {
    setBatchesOpen(false);
    openBatch(id);
  };
  const receiptProps = {
    batches: batchesQuery.data ?? [],
    storeId: currentStoreId,
    myMemberId: session.member.memberId,
    dateLabel,
    skus: allSkus,
    categories: categoriesQuery.data ?? [],
    onSelectBatch: selectBatch,
    onWithdraw: (sessionId: string) => withdraw.mutate({ sessionId }),
    withdrawing: withdraw.isPending,
  };

  // ORD-4: a batch opened from today's list, read-only, with a way back.
  if (otherBatch) {
    return <BatchReceipt {...receiptProps} batch={otherBatch} onBack={closeOtherBatch} />;
  }

  // The page's own batch, sent: its receipt, and the next batch.
  if (isReadOnly && sessionQuery.data) {
    return (
      <BatchReceipt
        {...receiptProps}
        batch={sessionQuery.data}
        onNewBatch={startNewBatch}
        staleWarning={staleWarning}
      />
    );
  }

  const rejected = otherRejectedBatch(batchesQuery.data, sessionQuery.data?.id);
  return (
    <div className="flex flex-col">
      {/* M3.12-B (2026-05-16): the [date · selectedCount] row is gone.
          Both halves of the strip were redundant:
          - Date appears in the Telegram chrome (bot title bar shows
            the current view; users already orient by it).
          - Selected count is duplicated on the MainButton label
            ("Review Order (N)") which is always at the bottom of the
            screen and updates live. Showing the same number twice
            (top-right pill + MainButton) was visual stutter.
          The sticky strip now carries only the SearchInput + category
          ChipBar — the actual filters the user interacts with. */}
      <StickyPageBar direction="col">
        {canLeaveNewBatch ? (
          <Button
            size="sm"
            variant="ghost"
            className="-ml-3 self-start font-semibold"
            onClick={leaveNewBatch}
          >
            <span aria-hidden>‹</span> {i18n.t('order.batches.backToReceipt')}
          </Button>
        ) : null}
        {/* 2026-07-30 (flow review): the store you are ordering for was
            stated NOWHERE on this page. See the StoreChip docblock —
            with the picker two taps deep in Telegram's overflow and the
            selection persisted, an owner could spend a day ordering into
            the wrong store with no cue at all.

            Later the same day: the chip moved OUT of here and into
            Shell's top strip, centered in the slot Telegram leaves
            between its Close and ⋯ buttons. It is page-independent
            context, so one instance in the shell beats a copy in each
            page's sticky bar — and Run / Admin, which never had one,
            get it for free. What stays here is the batch count, which
            IS page state.

            Losing the chip left the batch count alone on a row of its
            own, `ml-auto` pinning it to the right edge with a hand's
            width of nothing beside it. It rides the search row now:
            one less row on a 375-px screen, and "field + trailing
            action" is a shape people already read. */}
        <div className="flex items-center gap-2">
          <SearchInput
            className="flex-1"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onClear={() => setSearchQuery('')}
            placeholder={i18n.t('order.search.placeholder')}
            clearAriaLabel={i18n.t('common.clear')}
            aria-label={i18n.t('order.search.placeholder')}
          />
          {/* Batch count stays visible while drafting too — otherwise
              "再报一批" drops you into an empty catalog identical to a
              first-of-the-day order, with nothing saying the earlier
              batches exist. */}
          {(batchesQuery.data?.length ?? 0) > 1 ? (
            // ORD-22: the kit's Button, not a hand-made pill (UI-16).
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 tabular-nums"
              onClick={() => setBatchesOpen(true)}
            >
              {/* U5: the draft being filled in is not counted. */}
              {i18n.t('order.batches.today', { n: sentBatchCount(batchesQuery.data) })}
            </Button>
          ) : null}
        </div>
        {/* V4: -my-1.5 py-1.5 instead of py-0 — same layout, but the
            scroller keeps the 6px above and below that the chips' 44px tap
            areas (hit-44) need; a scroller clips everything past its padding. */}
        <ChipBar ariaLabel={i18n.t('order.categoriesAriaLabel')} className="-mx-4 -my-1.5 px-4 py-1.5">
          {/* M3.10: "All" clears the search too (useCatalogFilter). */}
          <Chip selected={activeCategory === null} onClick={showAll}>
            {i18n.t('order.categories.all')}
          </Chip>
          <DataState query={categoriesQuery}>
            {(cats) =>
              cats.map((c) => (
                <Chip
                  key={c.id}
                  selected={activeCategory === c.id}
                  onClick={() => setActiveCategory(c.id)}
                >
                  {productName({ names: c.names })}
                </Chip>
              ))
            }
          </DataState>
        </ChipBar>
      </StickyPageBar>
      {staleWarning}
      {/* ORD-3 (2026-10-30): changes waiting in the outbox were invisible. */}
      <PendingSyncNotice count={pendingChangeCount(offline.pendingEntries)} saving={offline.savingSlow} />
      {rejected ? (
        <div className="px-4 pt-3">
          <RejectedBatchNotice batch={rejected} onOpen={selectBatch} />
        </div>
      ) : null}

      {/* The order being edited is a draft or a rejected batch: a sent,
          approved or bought one shows its receipt (above), and in a new
          batch the sent one is hidden (hideSentWhileNewBatch). A draft
          is never claimed. Review ORD-12 (2026-11): so only a rejected
          batch has a status to state here; the banners for the others
          never showed. DX-ORD-3 (2026-11-01): no 撤回 here. A rejected
          batch is edited in place already (OrderStatusBanner). */}
      {sessionStatus === 'rejected' && sessionQuery.data ? (
        <div className="px-4 pt-2">
          <OrderStatusBanner
            batch={sessionQuery.data}
            storeId={currentStoreId}
            myMemberId={session.member.memberId}
            editing
          />
        </div>
      ) : null}

      {draftEmpty && repeatFill.length > 0 ? (
        <div className="flex flex-col gap-1.5 px-4 pt-3">
          <Button block variant="secondary" onClick={repeatLastOrder}>
            {i18n.t('order.repeatLast.action')}
          </Button>
          <p className="text-center text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('order.repeatLast.hint')}
          </p>
        </div>
      ) : null}

      {/* DX-ORD-4 (2026-11-01): "empty" is judged on what can be ordered —
          it was judged on the list including archived products, so a
          catalog of only archived ones showed a blank page — and says why,
          not "tap + next to a product" when there is none to tap. */}
      <DataState
        query={skusQuery}
        emptyWhen={() => skus.length === 0}
        empty={
          <EmptyState
            title={i18n.t('order.catalogEmpty.title')}
            description={i18n.t('order.catalogEmpty.description', {
              path: i18n.t('common.navPath', {
                parent: i18n.t('nav.admin'),
                child: i18n.t('admin.section.catalog'),
              }),
            })}
          />
        }
      >
        {() => (
          <ul className="flex flex-col" role="list">
            {filteredSkus.length === 0 && (deferredSearch || activeCategory) ? (
              <li>
                {/* Review UI-13 (2026-11-11): a line in the list, as on the
                    run preview, not a page heading inside it. */}
                <EmptyState
                  compact
                  title={i18n.t('order.search.noMatches.title')}
                  description={i18n.t('order.search.noMatches.description')}
                />
              </li>
            ) : null}
            {catalogGroups.map((group) => {
              // DX-ORD-6: headings under "All"; a picked category is its own
              // heading already. Archived lines always say what they are.
              const showHeading =
                group.key !== 'search' && (group.archived || activeCategory === null);
              const heading = group.archived
                ? i18n.t('order.review.archived')
                : group.categoryId
                  ? (categoryNameById.get(group.categoryId) ?? '')
                  : i18n.t('order.categories.uncategorized');
              return (
                <li key={group.key}>
                  {showHeading ? (
                    <SectionLabel
                      as="h3"
                      className={cn('pt-3', group.archived && 'text-[var(--c-warning-fg)]')}
                    >
                      {heading}
                    </SectionLabel>
                  ) : null}
                  <ul className="flex flex-col" role="list">
                    {group.skus.map((sku) => (
                      <SkuRow
                        key={sku.id}
                        sku={sku}
                        archived={!!sku.isArchived}
                        myQty={myQtyBySku.get(sku.id) ?? 0}
                        totalQty={totalQtyBySku.get(sku.id) ?? 0}
                        otherContribCount={
                          (contributorsBySku.get(sku.id) ?? [])
                            .filter((c) => c.memberId !== myMemberId).length
                        }
                        isReadOnly={isReadOnly}
                        storeId={currentStoreId}
                        productNameParts={productNameParts}
                        unitLabel={unitLabel}
                        i18n={i18n}
                        onQtyChange={handleQtyChange}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      {/* Session-level "其他物品" structured extras (M3.16-C,
          2026-05-16). Replaces the M1.8 free-text textarea with a
          structured list of {name, qty, unit, note?} rows. Sits at
          the bottom of the SKU list so it's the last thing the staff
          sees before reviewing — natural placement for "and these
          items aren't in the catalog". Read-only once the session
          leaves draft (shown read-only on Approval / Run pages).
          2026-10-21 audit CA-27: also rendered BEFORE any session
          exists — an order of only non-catalog items is legitimate;
          the first save lazy-creates the draft (see saveExtras). */}
      {showExtrasEditor ? (
        <SessionExtrasEditor
          sessionId={extrasSessionId}
          storeId={currentStoreId ?? ''}
          // Rows saved before M3.34 (2026-05-19) may carry free text such
          // as "kgs" or "公斤". ORD-13 (2026-11-11): shown as written, not
          // turned into 'kg' (which re-saving then made true); the editor
          // asks for a unit from the list before it saves again.
          initialValue={sessionQuery.data?.extras ?? []}
          isReadOnly={isReadOnly}
          onSave={saveExtras}
        />
      ) : null}

      {/* O1: the review is an optional look now; the main button submits. */}
      {canSubmit && selectedCount > 0 ? (
        <div className="flex justify-center px-4 py-3">
          <Button variant="ghost" onClick={() => setReviewOpen(true)}>
            {i18n.t('order.review.view')}
          </Button>
        </div>
      ) : null}

      {/* An in-page "Review order (N)" fallback used to live here, gated on
          `!getTg()` — "only outside Telegram, where there's no MainButton".
          Deleted 2026-07-30. It never rendered (getTg() is truthy in any
          browser: the SDK is a static script tag), and it MUST not: since
          M3.49 the in-DOM <PageMainButton /> in Shell renders in every
          environment and already carries this exact action. Reviving the
          branch by "fixing" its predicate would just show the button
          twice. The other five sites that conflated SDK-present with
          inside-Telegram needed real fixes; this one needed deleting. */}

      {/* Review sheet — an optional preview of what is being submitted
          (O1), opened from "View order". Its footer submits, since the
          page's main button sits behind an open sheet. Tap-outside /
          swipe-down dismisses it. */}
      {/* Today's batches, reachable while drafting. Without this the count
          above was informational only: you could see that an earlier batch
          existed but not what was in it or where it had got to. */}
      <Sheet
        open={batchesOpen}
        onOpenChange={setBatchesOpen}
        title={i18n.t('order.batches.today', { n: sentBatchCount(batchesQuery.data) })}
      >
        <div className="py-3">
          <BatchStrip
            batches={batchesQuery.data ?? []}
            currentId={sessionQuery.data?.id ?? ''}
            i18n={i18n}
            currency={orgCurrency}
            showHeading={false}
            onSelect={selectBatch}
          />
        </div>
      </Sheet>

      <Sheet
        open={reviewOpen}
        onOpenChange={(open) => !open && !submit.isPending && setReviewOpen(false)}
        title={i18n.t('order.review.title')}
        description={
          // DX-ORD-12: "7 items + 1 other item" — other items are not products.
          // ORD-20: the "+" is the catalog's (order.batches.itemsAndExtras).
          dateLabel +
          ' · ' +
          (extrasCount > 0
            ? i18n.t('order.batches.itemsAndExtras', {
                items: i18n.t('order.review.itemsCount', { n: totals.length }),
                extras: i18n.t('order.batches.extras', { n: extrasCount }),
              })
            : i18n.t('order.review.itemsCount', { n: totals.length }))
        }
        footer={
          // M3.49: in-page PageMainButton sits behind any open sheet —
          // we must render the sheet's own footer button so the user
          // has something to tap.
          <div className="flex flex-col gap-2">
            {/* DX-ORD-5: offline the button is off and says why. */}
            {!offline.online ? (
              <p id="order-submit-offline" className="text-center text-old-label text-[var(--c-fg-muted)]">
                {i18n.t('order.review.needsNetwork')}
              </p>
            ) : null}
            <Button
              block
              size="lg"
              loading={submit.isPending}
              disabled={selectedCount === 0 || !offline.online}
              aria-describedby={!offline.online ? 'order-submit-offline' : undefined}
              onClick={() => {
                if (!sessionQuery.data) return;
                void handleSubmit();
              }}
            >
              {submit.isPending
                ? i18n.t('order.action.submitting')
                : i18n.t('order.action.submitOrder')}
            </Button>
          </div>
        }
      >
        {/* A11Y-7 (2026-10-31): the list is the sheet's first focus stop, so
            opening 复核订单 with the keyboard lands on what is being
            ordered. Focus used to land on 提交订单 itself, where a repeated
            Enter submitted the order unread. */}
        <div
          tabIndex={0}
          role="region"
          aria-label={i18n.t('order.review.title')}
          className="rounded-[var(--r-utility)]"
        >
          {totals.length > 0 || extrasCount === 0 ? (
            <ReviewList
              totals={totals}
              skus={allSkus}
              categories={categoriesQuery.data ?? []}
              productName={productName}
              edit={
                currentStoreId && !isReadOnly
                  ? {
                      myQtyBySku,
                      onQtyChange: (skuId, qty) => handleQtyChange(currentStoreId, skuId, qty),
                    }
                  : undefined
              }
            />
          ) : null}
          {extrasCount > 0 && sessionQuery.data && sessionQuery.data.id !== 'optimistic' ? (
            <SessionExtrasEditor
              sessionId={sessionQuery.data.id}
              storeId={currentStoreId}
              initialValue={sessionQuery.data.extras ?? []}
              isReadOnly
              inSheet
              onSave={async () => {
                /* read-only — never called */
              }}
            />
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}
