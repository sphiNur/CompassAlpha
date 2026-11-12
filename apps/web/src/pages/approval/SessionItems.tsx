import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Banner,
  Button,
  LoadingState,
  NameCell,
  OfflineState,
  QtyControl,
  SectionLabel,
  isWaitingOffline,
} from '@compass/ui';
import { trpc } from '../../lib/trpc';
import { useI18n, useProductNameParts, useUnitLabel } from '../../hooks/useI18n';
import { rowName } from '../../lib/productName';
import { useCurrency } from '../../hooks/useCurrency';
import { useErrToast } from '../../hooks/useErrToast';
import { useOrderEstimate } from '../../hooks/useOrderEstimate';
import { extrasChanged, submittedDiff } from '../order/submittedDiff';
import { formatQty, formatMoney } from '../../lib/format';
import { sessionItemsView } from './sessionItemsView';
import { changedSinceSeen, snapshotOrder, zeroedInReview, type SeenOrder } from './reviewDiff';
import { QtyDrafts } from './qtyDrafts';
import { ORDER_QTY_MAX } from '@compass/contracts/limits';
import { moneyLine } from '../../lib/money';

/**
 * Per-SKU expanded view inside the approval queue. Shows the running
 * total per SKU AND a sub-list of each contributor's qty (per #6 — the
 * manager wants to see who asked for what). Each contributor row has
 * a +/- control so the manager can adjust in place WITHOUT bouncing
 * the order back to draft. The mutation uses `targetMemberId` so the
 * server applies the manager-override path.
 */
export function SessionItems({
  sessionId,
  storeId,
  skuById,
  productName,
  isClaimedByMe,
  claimOnEditSeq,
  onHold,
}: {
  /** DX-APR-2 / 3: holds the card's 「通过」 while edits or unseen changes are pending. */
  onHold: (sessionId: string, hold: boolean) => void;
  sessionId: string;
  storeId: string;
  // `step` is REQUIRED (2026-07-30) — see the skuById docblock in the
  // parent. An optional `step` is how the whole-unit-increment bug hid.
  skuById: Map<string, { names: Record<string, string>; unit: string; step: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  isClaimedByMe: boolean;
  /** U2 (2026-10-31): set when the order is unclaimed and the viewer may
   *  claim it — the version on screen. A quantity change then claims the
   *  order in the same write, refused if someone changed it since. */
  claimOnEditSeq?: number;
}) {
  const i18n = useI18n();
  const canEdit = isClaimedByMe || claimOnEditSeq !== undefined;
  const unitLabel = useUnitLabel();
  // UI-4: a row's name on two lines; `productName` is for one-line text.
  const productNameParts = useProductNameParts();
  // M1.21: pull org currency from session for the estimate-total
  // suffix. Hardcoded "UZS" pre-M1.21 blocked the multi-currency
  // foundation from M1.17.
  const currency = useCurrency();
  const detail = trpc.order.sessionDetail.useQuery({ sessionId });
  // 2026-11-05: the order as submitted, so review edits read against it.
  const submittedQ = trpc.order.submittedVersion.useQuery({ sessionId }, { staleTime: 30_000 });
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  const adjust = trpc.order.adjustItem.useMutation({
    // DX-APR-1: returning the refetch keeps the write pending until the
    // card's version (lastSeq) includes this change, so 通过 stays held
    // until then and the approval carries the version the reviewer saw.
    // DX-APR-3: our own edit moves the seq too; it is not a change by
    // someone else, so the copy of the order that includes it is the
    // new baseline.
    onSuccess: (data) => {
      rebaselineAt.current = Math.max(rebaselineAt.current ?? 0, data.lastSeq);
      return Promise.all([
        utils.order.sessionDetail.invalidate({ sessionId }),
        utils.order.pendingList.invalidate(),
      ]);
    },
    onError: (err) => {
      // U2: the order changed or someone claimed it first — show it as it is now.
      void utils.order.sessionDetail.invalidate({ sessionId });
      void utils.order.pendingList.invalidate();
      errToast('order.toast.adjustFailed')(err);
    },
  });
  // DX-APR-2: taps add up locally; the final value goes out once they stop.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // 2026-11-05: the 原提交订单 list, open unless the reviewer folds it.
  const [originalOpen, setOriginalOpen] = useState(true);
  /** The seq of our own last write; the first copy at or past it is the new baseline. */
  const rebaselineAt = useRef<number | null>(null);
  const adjustRef = useRef(adjust);
  adjustRef.current = adjust;
  const editCtx = useRef({ date: undefined as string | undefined, claimOnEditSeq });
  editCtx.current = { date: detail.data?.orderDate, claimOnEditSeq };
  const drafts = useMemo(
    () =>
      new QtyDrafts(async (key, value) => {
        const [skuId, targetMemberId] = key.split('|') as [string, string];
        try {
          await adjustRef.current.mutateAsync({
            storeId,
            // 2026-07-30 (flow review): pass the SESSION's date. Omitting
            // it made the server default to today, so adjusting a session
            // submitted on an earlier day looked up the wrong row.
            date: editCtx.current.date,
            skuId,
            qty: String(value),
            targetMemberId,
            // APR-1: name the batch being reviewed; the server used to
            // guess it and could edit the same person's other batch.
            sessionId,
            expectedSeq: editCtx.current.claimOnEditSeq,
          });
        } catch {
          /* onError shows it and refreshes the order */
        }
      }, rerender),
    [sessionId, storeId],
  );
  // Review ORD-02 (2026-11-09): leaving the card sends the taps still
  // waiting instead of dropping them, and 「通过」 stays held until they
  // are answered (it used to unlock at once, on the old number). The
  // page being closed or hidden sends them too.
  useEffect(() => {
    const onPageHide = () => void drafts.flushAll();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      void drafts.dispose().finally(() => onHold(sessionId, false));
    };
  }, [drafts, onHold, sessionId]);
  const qtyKey = (skuId: string, memberId: string) => `${skuId}|${memberId}`;

  // DX-APR-3: the order as first seen (or last acknowledged).
  const seen = useRef<SeenOrder | null>(null);
  const now = detail.data ? snapshotOrder(detail.data.lastSeq, detail.data.totals ?? []) : null;
  if (
    now &&
    (!seen.current ||
      (rebaselineAt.current !== null && now.seq >= rebaselineAt.current && !drafts.busy))
  ) {
    seen.current = now;
    rebaselineAt.current = null;
  }
  const changed = now ? changedSinceSeen(seen.current, now) : new Map<string, number>();
  const hold = drafts.busy || changed.size > 0;
  useEffect(() => {
    onHold(sessionId, hold);
  }, [hold, onHold, sessionId]);

  // The estimate is hooked here (BEFORE early returns, fixed 2026-05-05)
  // so React's hooks-order invariant holds across loading/empty/error
  // branches. Manager sees estimated budget before approving. ORD-01: the
  // server's rule for the card's "~", so the card and this detail agree
  // to the cent. D6 (2026-10-31): priced for the order's store (no
  // amounts where the approver lacks prices.view).
  const { estimate, lastPriceOf } = useOrderEstimate(detail.data?.totals, detail.data?.storeId);

  if (detail.isLoading) {
    return (
      <LoadingState
        variant="inline"
        label={i18n.t('approval.items.loading')}
        className="border-t border-[var(--c-divider)] px-4 py-3"
      />
    );
  }
  if (isWaitingOffline(detail)) {
    // R2-ENG-1 (2026-10-31): offline, an order never opened before has no
    // saved lines; it is not an empty order.
    return <OfflineState compact className="border-t border-[var(--c-divider)]" />;
  }
  if (detail.isError) {
    return (
      <div className="border-t border-[var(--c-divider)] px-4 py-3 text-old-body-sm text-[var(--c-danger)]">
        {i18n.t('approval.items.failed')}
      </div>
    );
  }
  const totals = (detail.data?.totals ?? []).filter((t) => Number(t.qty) > 0);
  const rawItems = detail.data?.items ?? [];
  const sessionNotes = detail.data?.notes ?? null;
  const sessionExtras = detail.data?.extras ?? [];
  // 2026-10-21 FE-02: the empty state used to return before extras and
  // notes rendered, so an extras-only order read "empty" to the manager.
  // Now "empty" covers the SKU section only; the whole block reads empty
  // only when SKUs, extras and notes are all absent.
  const view = sessionItemsView({ totals, extras: sessionExtras, notes: sessionNotes });
  // DX-APR-8: lines set to 0 in review stay, struck through and restorable.
  const zeroed = zeroedInReview(rawItems);
  // 2026-11-05: what review changed against the order as submitted.
  const vsSubmitted = submittedDiff(submittedQ.data?.totals, totals);
  const submittedExtras = submittedQ.data?.extras;
  const showSubmittedExtras = extrasChanged(submittedExtras, sessionExtras);
  // DX-APR-3: lines that changed since opening and are no longer on the order.
  const removedSinceSeen = [...changed.entries()].filter(
    ([skuId]) => !totals.some((t) => t.skuId === skuId),
  );
  const changeBanner =
    changed.size > 0 ? (
      <div className="px-4 pt-3">
        <Banner
          tone="warn"
          title={i18n.t('approval.changed.title')}
          action={
            <Button
              size="sm"
              variant="pearl"
              data-testid="approval-changes-seen"
              onClick={() => {
                seen.current = now;
                rerender();
              }}
            >
              {i18n.t('approval.changed.ack')}
            </Button>
          }
        >
          {removedSinceSeen.length > 0
            ? removedSinceSeen
                .map(([skuId, from]) => {
                  const sku = skuById.get(skuId);
                  return i18n.t('approval.changed.removed', {
                    item: sku ? productName(sku) : i18n.t('common.unknownProduct'),
                    from: formatQty(from),
                    unit: unitLabel(sku?.unit ?? '', from),
                  });
                })
                .join(' · ')
            : i18n.t('approval.changed.body')}
        </Banner>
      </div>
    ) : null;
  if (view.allEmpty && zeroed.length === 0) {
    return (
      <div className="border-t border-[var(--c-divider)] px-4 py-3 text-old-body-sm text-[var(--c-fg-muted)]">
        {i18n.t('approval.items.empty')}
      </div>
    );
  }

  // Group raw items by SKU for the breakdown. ORD-09 (2026-11-11): the
  // contributor's name comes with the line; it was looked up in
  // admin.memberList, which needs users.manage.
  const rowsBySku = new Map<
    string,
    Array<{ contributorMemberId: string; contributorName: string; qty: string }>
  >();
  for (const it of rawItems) {
    if (Number(it.qty) <= 0) continue;
    const arr = rowsBySku.get(it.skuId) ?? [];
    arr.push({
      contributorMemberId: it.contributorMemberId,
      contributorName: it.contributorName ?? i18n.t('people.memberFallback'),
      qty: it.qty,
    });
    rowsBySku.set(it.skuId, arr);
  }

  return (
    <div className="border-t border-[var(--c-divider)]">
      {changeBanner}
      {/* Session-level "其他物品" requests. M1.8 carried free-text in
        `notes`; M3.16-C ships a structured list in `extras`. Both
        surfaces render side-by-side here (legacy notes from pre-M3.16
        sessions + new extras from M3.16+ sessions) so the manager
        sees everything the store asked for in one place. Yellow tint
        because these are off-catalog and need extra scrutiny. */}
      {view.showExtras ? (
        <div className="border-b border-[var(--c-divider)] bg-[var(--c-warn-bg)] px-4 py-2.5">
          <SectionLabel padded={false}>{i18n.t('order.extras.label')}</SectionLabel>
          <ul className="mt-1 flex flex-col gap-0.5">
            {sessionExtras.map((e, idx) => (
              <li
                key={`${e.name}-${idx}`}
                className="flex items-baseline justify-between gap-2 text-old-body"
              >
                <span className="min-w-0 flex-1 break-words text-[var(--c-fg)]">{e.name}</span>
                <span className="shrink-0 tabular-nums text-[var(--c-fg-muted)]">
                  {formatQty(e.qty)} {unitLabel(e.unit, e.qty)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.showNotes ? (
        <div className="border-b border-[var(--c-divider)] bg-[var(--c-warn-bg)] px-4 py-2.5">
          <SectionLabel padded={false}>{i18n.t('order.notes.label')}</SectionLabel>
          <div className="mt-1 whitespace-pre-wrap text-old-body leading-snug text-[var(--c-fg)]">
            {sessionNotes}
          </div>
        </div>
      ) : null}
      {/* Estimated budget row (added 2026-05-05). Tells the manager
        roughly how much approval-then-purchase will cost, at each
        product's last price paid. Products never bought are left out
        and counted. */}
      {estimate.known > 0 ? (
        <div className="flex items-baseline justify-between gap-2 px-4 py-2 text-old-label text-[var(--c-fg-muted)]">
          <span className="font-semibold">{i18n.t('order.review.estimatedTotal')}</span>
          <span className="text-old-body font-semibold tabular-nums text-[var(--c-fg)]">
            ~{formatMoney(estimate.total, currency)}
            {estimate.unknown > 0 ? (
              <span className="ml-2 font-sans font-normal text-[var(--c-warning-fg)]">
                {i18n.t('approval.estimateUnpriced', { n: estimate.unknown })}
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {view.skuSectionEmpty && zeroed.length === 0 ? (
        <div className="px-4 py-3 text-old-body-sm text-[var(--c-fg-muted)]">
          {i18n.t('approval.items.noCatalogItems')}
        </div>
      ) : null}
      {view.hasSkus ? (
        <ul className="flex flex-col px-4 py-2" role="list">
          {totals.map((t) => {
            const sku = skuById.get(t.skuId);
            const rows = rowsBySku.get(t.skuId) ?? [];
            // M3.34 (2026-05-19, Q4 cleanup): collapse the contributor
            // breakdown when there's only ONE contributor. The submitter's
            // name is already in the order card header; repeating it on
            // every SKU row was redundant and ate screen space. For a
            // single-contributor session in claimed mode, the QtyControl
            // moves up onto the SKU header itself in place of the static
            // qty span.
            const isSingleContributor = rows.length === 1;
            const singleRow = isSingleContributor ? rows[0]! : null;
            const unitPrice = Number(lastPriceOf(t.skuId) ?? 0) || null;
            const before = changed.get(t.skuId);
            const sub = vsSubmitted.get(t.skuId);
            return (
              <li
                key={t.skuId}
                data-changed={before !== undefined || undefined}
                className={
                  'border-b border-[var(--c-divider)] py-3 last:border-b-0' +
                  (before !== undefined ? ' -mx-4 bg-[var(--c-warn-bg)] px-4' : '')
                }
              >
                {before !== undefined ? (
                  <div className="mb-1 text-old-label font-semibold tabular-nums text-[var(--c-warning-fg)]">
                    {i18n.t('approval.changed.line', {
                      from: formatQty(before),
                      to: formatQty(t.qty),
                      unit: unitLabel(sku?.unit ?? '', t.qty),
                    })}
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-2 text-old-body">
                  <NameCell
                    {...rowName(productNameParts, sku, i18n.t('common.unknownProduct'))}
                    className="flex-1"
                    primaryClassName="line-clamp-none"
                  />
                  {canEdit && isSingleContributor && sku && singleRow ? (
                    <QtyControl
                      size="sm"
                      itemLabel={productName(sku)}
                      value={
                        drafts.value(qtyKey(t.skuId, singleRow.contributorMemberId)) ??
                        Number(singleRow.qty)
                      }
                      step={Number(sku.step)}
                      unit={unitLabel.uncounted(sku.unit)}
                      unitFor={(qty) => unitLabel(sku.unit, qty)}
                      max={ORDER_QTY_MAX}
                      disabled={drafts.isSaving(qtyKey(t.skuId, singleRow.contributorMemberId))}
                      onChange={(next) =>
                        drafts.set(qtyKey(t.skuId, singleRow.contributorMemberId), next)
                      }
                    />
                  ) : (
                    <span className="shrink-0 tabular-nums text-[var(--c-fg)]">
                      {formatQty(t.qty)} {unitLabel(sku?.unit ?? '', t.qty)}
                    </span>
                  )}
                </div>
                {sub?.kind === 'changed' ? (
                  <div
                    data-testid="approval-line-submitted"
                    className="mt-0.5 text-old-label tabular-nums text-[var(--c-fg-muted)]"
                  >
                    {i18n.t('order.submitted.was', {
                      qty: formatQty(sub.before),
                      unit: unitLabel(sku?.unit ?? '', sub.before),
                    })}
                  </div>
                ) : sub?.kind === 'added' ? (
                  <div
                    data-testid="approval-line-submitted"
                    className="mt-0.5 text-old-label font-semibold text-[var(--c-warning-fg)]"
                  >
                    {i18n.t('order.submitted.added')}
                  </div>
                ) : null}
                {/* 2026-10-11: what one costs, how it is usually paid, and
                what the line comes to. A line of its own under the name,
                holding only figures and one word, so a long product name
                in any language has nothing to share its line with. */}
                {unitPrice || t.usualPayment ? (
                  <div
                    data-testid="approval-line-price"
                    className="mt-0.5 flex items-baseline justify-between gap-2 text-old-label tabular-nums text-[var(--c-fg-muted)]"
                  >
                    <span className="min-w-0">
                      {unitPrice
                        ? `~${formatMoney(unitPrice)} / ${unitLabel.uncounted(sku?.unit ?? '')}`
                        : null}
                      {unitPrice && t.usualPayment ? ' · ' : null}
                      {t.usualPayment
                        ? i18n.t(
                            t.usualPayment === 'transfer'
                              ? 'run.label.paymentTransfer'
                              : 'run.label.paymentCash',
                          )
                        : null}
                    </span>
                    {unitPrice ? (
                      <span className="shrink-0 tabular-nums">
                        ~{formatMoney(moneyLine(t.qty, lastPriceOf(t.skuId)))}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {/* Per-contributor breakdown only when 2+ contributors —
                whether or not claimed. Hiding for single-contributor
                avoids the noisy repeated submitter name. */}
                {rows.length > 1 ? (
                  <ul className="mt-1 flex flex-col gap-1 pl-3" role="list">
                    {rows.map((r) => (
                      <li
                        key={r.contributorMemberId}
                        className="flex items-center justify-between gap-2 text-old-label text-[var(--c-fg-muted)]"
                      >
                        <span className="truncate">{r.contributorName}</span>
                        {canEdit && sku ? (
                          <QtyControl
                            size="sm"
                            itemLabel={`${productName(sku)} · ${r.contributorName}`}
                            value={
                              drafts.value(qtyKey(t.skuId, r.contributorMemberId)) ?? Number(r.qty)
                            }
                            step={Number(sku.step)}
                            unit={unitLabel.uncounted(sku.unit)}
                            unitFor={(qty) => unitLabel(sku.unit, qty)}
                            max={ORDER_QTY_MAX}
                            disabled={drafts.isSaving(qtyKey(t.skuId, r.contributorMemberId))}
                            onChange={(next) =>
                              drafts.set(qtyKey(t.skuId, r.contributorMemberId), next)
                            }
                          />
                        ) : (
                          <span className="shrink-0 tabular-nums">
                            {formatQty(r.qty)} {unitLabel(sku?.unit ?? '', r.qty)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {zeroed.length > 0 ? (
        <ul className="flex flex-col px-4 pb-2" role="list" data-testid="approval-zeroed">
          {zeroed.map((z) => {
            const sku = skuById.get(z.skuId);
            const key = qtyKey(z.skuId, z.contributorMemberId);
            const sub = vsSubmitted.get(z.skuId);
            return (
              <li
                key={key}
                className="border-b border-[var(--c-divider)] py-3 text-old-body last:border-b-0"
              >
                {/* Walkthrough F3 (2026-11-05): the hint sat beside the stepper
                  and broke over three lines ("提交/时"). It now runs under
                  the name and stepper at full width. */}
                <div className="flex items-center justify-between gap-2">
                  <NameCell
                    {...rowName(productNameParts, sku, i18n.t('common.unknownProduct'))}
                    className="flex-1 text-[var(--c-fg-muted)] line-through"
                    primaryClassName="line-clamp-none font-normal text-[var(--c-fg-muted)]"
                  />
                  {canEdit && sku ? (
                    <QtyControl
                      size="sm"
                      itemLabel={productName(sku)}
                      value={drafts.value(key) ?? 0}
                      step={Number(sku.step)}
                      unit={unitLabel.uncounted(sku.unit)}
                      unitFor={(qty) => unitLabel(sku.unit, qty)}
                      max={ORDER_QTY_MAX}
                      disabled={drafts.isSaving(key)}
                      onChange={(next) => drafts.set(key, next)}
                    />
                  ) : null}
                </div>
                <p className="mt-1 text-old-label tabular-nums text-[var(--c-fg-muted)]">
                  {i18n.t('approval.zeroed')}
                  {sub?.kind === 'removed' ? (
                    <>
                      {' · '}
                      <span className="whitespace-nowrap">
                        {i18n.t('order.submitted.was', {
                          qty: formatQty(sub.before),
                          unit: unitLabel(sku?.unit ?? '', sub.before),
                        })}
                      </span>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
      {/* 2026-11-05 (owner): every order, pending or decided, shows the
        whole order as the store submitted it — each product with its
        quantity and unit — not only the lines review changed. */}
      {submittedQ.data ? (
        <div
          className="border-t border-[var(--c-divider)] px-4 py-2"
          data-testid="approval-original"
        >
          <button
            type="button"
            className="press flex min-h-11 w-full items-center justify-between gap-2 text-left"
            aria-expanded={originalOpen}
            onClick={() => setOriginalOpen(!originalOpen)}
          >
            <span className="text-old-body font-semibold text-[var(--c-fg)]">
              {i18n.t('order.submitted.showOriginal')}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-old-label text-[var(--c-fg-muted)]">
              {vsSubmitted.size > 0 || showSubmittedExtras
                ? i18n.t('order.submitted.changedShort')
                : i18n.t('order.submitted.unchanged')}
              <span aria-hidden>{originalOpen ? '▾' : '▸'}</span>
            </span>
          </button>
          {originalOpen ? (
            <ul className="flex flex-col pb-1" role="list">
              {submittedQ.data.totals.map((t) => {
                const sku = skuById.get(t.skuId);
                const ch = vsSubmitted.get(t.skuId);
                return (
                  <li
                    key={t.skuId}
                    className="flex items-baseline justify-between gap-3 border-b border-[var(--c-divider)] py-1.5 text-old-body last:border-b-0"
                  >
                    <NameCell
                      {...rowName(productNameParts, sku, i18n.t('common.unknownProduct'))}
                      className="flex-1"
                      primaryClassName="line-clamp-none font-normal"
                    />
                    <span
                      className={`shrink-0 tabular-nums ${ch ? 'font-semibold text-[var(--c-warning-fg)]' : 'text-[var(--c-fg-muted)]'}`}
                    >
                      {formatQty(t.qty)} {unitLabel(sku?.unit ?? '', t.qty)}
                    </span>
                  </li>
                );
              })}
              {(submittedExtras ?? []).map((e, idx) => (
                <li
                  key={`x-${e.name}-${idx}`}
                  className="flex items-baseline justify-between gap-3 border-b border-[var(--c-divider)] py-1.5 text-old-body last:border-b-0"
                >
                  <span className="min-w-0 flex-1 break-words text-[var(--c-fg)]">{e.name}</span>
                  <span className="shrink-0 tabular-nums text-[var(--c-fg-muted)]">
                    {formatQty(e.qty)} {unitLabel(e.unit, e.qty)}
                  </span>
                </li>
              ))}
              {submittedQ.data.totals.length === 0 && (submittedExtras ?? []).length === 0 ? (
                <li className="py-1.5 text-old-body text-[var(--c-fg-muted)]">—</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
