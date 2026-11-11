/**
 * ConfirmPage — store-side acceptance.
 *
 * Lists items delivered to my current store across all in-flight runs, lets
 * the receiver mark each item ok / short / wrong / quality. When all are
 * decided, a Confirm Store button finalizes the store side.
 *
 * A problem carries a note, the quantity that arrived and an optional
 * photo (PhotoCapture, uploaded through usePhotoUploader). The page holds
 * the queries and the three writes; the rules are in confirm/confirmLogic.ts
 * and the parts in confirm/ (review CONF-07).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  Chip,
  ChipBar,
  ConfirmSheet,
  DataState,
  EmptyState,
  LoadingState,
  OfflineState,
  Sheet,
  StickyPageBar,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { haptic } from '../lib/telegram';
import { useDateFormat, useI18n, useProductNameParts } from '../hooks/useI18n';
import { usePhotoUploader } from '../hooks/usePhotoUploader';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { useQueueOnNetworkError } from '../hooks/useOfflineWrite';
import { PendingSyncNotice } from '../components/PendingSyncNotice';
import { pendingChangeCount } from '../lib/pendingChanges';
import { overlayPendingWrites, pendingStoreIds, withData } from './runs/lib/pendingOverlay';
import { NoStoreYet, useNoStoreYet } from '../components/NoStoreYet';
import { useStoreContext } from '../components/StoreSwitcher';
import {
  countVerdicts,
  defaultDeliveringRunId,
  deliveringRunsForStore,
  issueFormCheck,
  receivingWait,
  runsListView,
  unboughtForStore,
  verdictSummaryParts,
  withLineVerdict,
  type ConfirmDecisionStatus,
  type ItemVerdict,
  type ReceivingWait,
} from './confirm/confirmLogic';
import { ConfirmItemRow, type ConfirmLine } from './confirm/ConfirmItemRow';
import { IssueSheet } from './confirm/IssueSheet';
import { ReceivingWaitState } from './confirm/ReceivingWaitState';
import { UnboughtCard } from './confirm/UnboughtCard';
import { useConfirmMainButton } from './confirm/useConfirmMainButton';
import { useIssueForm, type ReportedLine } from './confirm/useIssueForm';

export function ConfirmPage() {
  const i18n = useI18n();
  const dates = useDateFormat();
  const productNameParts = useProductNameParts();
  const session = useAuthStore((s) => s.session);
  // ConfirmPage needs a SPECIFIC store — staff confirm receipt at THEIR
  // store. Reading via the context helper coerces 'all' to null so the
  // pick-a-store empty-state takes over (added 2026-05-05).
  const storeCtx = useStoreContext();
  const noStoreYet = useNoStoreYet();
  const currentStoreId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const toast = useToast();
  const issueForm = useIssueForm();
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  // U4 (2026-10-31): 确认收货 is irreversible; it now goes through a
  // summary sheet instead of submitting on one tap.
  const [finalConfirmOpen, setFinalConfirmOpen] = useState(false);
  const photoUploader = usePhotoUploader('issue');

  const runsQuery = trpc.run.list.useQuery();
  // 2026-10-21 FE-01 / F4-02: loading / failed run.list must not render as
  // "nothing to confirm".
  const runsView = runsListView({
    isLoading: runsQuery.isLoading,
    isError: runsQuery.isError,
    hasData: runsQuery.data !== undefined,
    waitingOffline: runsQuery.fetchStatus === 'paused',
  });
  // CAT-7 (2026-10-30): include archived products so lines already ordered,
  // approved or bought still show their name and unit (they showed as an id
  // fragment, or not at all). Pickers filter archived ones out.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  const utils = trpc.useUtils();
  // Receivers also confirm from inside the store, often with terrible
  // wifi: confirmations queue offline. Replay is app-level (CMP-FE-3).
  const offline = useOfflineQueue();

  /**
   * 2026-10-21 CA-04: more than one run can be delivering at once (a new
   * trip may start while an earlier one still waits for signatures), so
   * "the first delivering run" is no longer THE run. Every delivering run
   * with goods for this store is a candidate; the picker below opens on
   * the oldest one this store has not signed for yet.
   */
  const candidateRuns = useMemo(
    () => deliveringRunsForStore(runsQuery.data ?? [], currentStoreId),
    [runsQuery.data, currentStoreId],
  );
  const candidateDetails = trpc.useQueries((t) =>
    candidateRuns.map((r) => t.run.get({ runId: r.id })),
  );
  const storeConfirmedByRun = useMemo(() => {
    const m = new Map<string, boolean | undefined>();
    candidateRuns.forEach((r, i) => {
      const data = candidateDetails[i]?.data;
      if (!data) {
        m.set(r.id, undefined);
        return;
      }
      const mine = data.splits.filter((sp) => sp.storeId === currentStoreId);
      m.set(r.id, mine.length > 0 && mine.every((sp) => !!sp.confirmedAt));
    });
    return m;
  }, [candidateRuns, candidateDetails, currentStoreId]);
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  // A picked run that stopped delivering (finished / cancelled) falls
  // back to the default instead of pinning a stale id.
  useEffect(() => {
    if (pickedRunId && !candidateRuns.some((r) => r.id === pickedRunId)) setPickedRunId(null);
  }, [pickedRunId, candidateRuns]);
  const activeRunId = pickedRunId ?? defaultDeliveringRunId(candidateRuns, storeConfirmedByRun);
  const activeRun = candidateRuns.find((r) => r.id === activeRunId) ?? null;
  const detailQueryRaw = trpc.run.get.useQuery(
    activeRun ? { runId: activeRun.id } : { runId: '' },
    { enabled: !!activeRun },
  );
  // RE-DLV-4 / R2-DLV-3 (2026-10-31): verdicts and the receipt saved
  // offline show on the page (waiting to sync) instead of the list looking
  // as if nothing was saved.
  const detailData = useMemo(
    () => overlayPendingWrites(detailQueryRaw.data, offline.pendingEntries),
    [detailQueryRaw.data, offline.pendingEntries],
  );
  const detailQuery = withData(detailQueryRaw, detailData);
  const confirmQueued = currentStoreId
    ? pendingStoreIds(activeRun?.id, offline.pendingEntries, 'run.confirmStore').has(currentStoreId)
    : false;

  const skuById = useMemo(() => {
    const m = new Map<string, { names: Record<string, string>; unit: string }>();
    for (const s of skusQuery.data ?? []) {
      m.set(s.id, { names: s.names as Record<string, string>, unit: s.unit });
    }
    return m;
  }, [skusQuery.data]);

  /** Show a verdict before the server answers (withLineVerdict). */
  const paintVerdict = (verdict: ItemVerdict) => {
    utils.run.get.setData({ runId: verdict.runId }, (old) =>
      old ? { ...old, splits: withLineVerdict(old.splits, verdict) } : old,
    );
  };
  const queueOnNetworkError = useQueueOnNetworkError();

  const confirmItem = trpc.run.confirmStoreItem.useMutation({
    onSuccess: (_data, vars) => {
      void utils.run.get.invalidate();
      issueForm.closeFor(vars);
      // Bug fix: previously this said "Issue noted" for EVERY confirm,
      // including the most common "ok" case — confusing. The toast now
      // matches what actually happened.
      if (vars.status === 'ok') {
        haptic('success');
        toast.success(i18n.t('confirm.toast.markedOk'));
      } else {
        haptic('warning');
        toast.info(i18n.t('confirm.toast.issueNoted'));
      }
    },
    onError: (err, vars) =>
      queueOnNetworkError(err, {
        procedure: 'run.confirmStoreItem',
        input: vars,
        failedKey: 'common.errors.actionFailed',
        queuedKey: 'confirm.toast.savedOffline',
        // COREWEB2-04: the form keeps what was typed when the device
        // could not store it either.
        onQueued: () => issueForm.closeFor(vars),
        // Take back the verdict shown ahead of the answer.
        onNotSaved: () => void utils.run.get.invalidate(),
      }),
  });
  const confirmStore = trpc.run.confirmStore.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      setFinalConfirmOpen(false);
      haptic('success');
      toast.success(i18n.t('confirm.toast.storeConfirmed'));
    },
    onError: (err, vars) =>
      queueOnNetworkError(err, {
        procedure: 'run.confirmStore',
        input: vars,
        failedKey: 'common.errors.actionFailed',
        queuedKey: 'confirm.toast.savedOffline',
        onQueued: () => setFinalConfirmOpen(false),
      }),
  });
  const bulkMarkOk = trpc.run.markStoreItemsOk.useMutation({
    onSuccess: (data) => {
      void utils.run.get.invalidate();
      setBulkConfirmOpen(false);
      if (data.marked > 0) {
        haptic('success');
        toast.success(i18n.t('confirm.toast.allMarkedOk', { n: data.marked }));
      } else {
        toast.info(i18n.t('confirm.toast.nothingToMark'));
      }
    },
    onError: (err, vars) =>
      queueOnNetworkError(err, {
        procedure: 'run.markStoreItemsOk',
        input: vars,
        failedKey: 'common.errors.actionFailed',
        queuedKey: 'confirm.toast.savedOffline',
        onQueued: () => setBulkConfirmOpen(false),
      }),
  });

  const myAllItems = (detailQuery.data?.splits ?? []).filter((sp) => sp.storeId === currentStoreId);
  // DX-DLV-13 (2026-11-01): products the purchaser did not find for this
  // store; they are listed as 没买到 so the store knows they are not coming.
  const unbought = currentStoreId
    ? unboughtForStore(
        detailQuery.data?.items ?? [],
        detailQuery.data?.perStoreDemand ?? [],
        currentStoreId,
      )
    : [];
  // DX-DLV-13: why there is nothing to check yet.
  const wait: ReceivingWait = currentStoreId
    ? receivingWait({
        storeId: currentStoreId,
        runs: runsQuery.data ?? [],
        active: activeRun ? (detailQuery.data ?? {}) : null,
      })
    : 'nothing';
  // 2026-10-21 audit CA-30: lines are only checkable once the purchaser
  // has handed them over (the server now refuses item confirms before
  // StoreDelivered). Until then the store sees the waiting state instead
  // of a list it could tick off for goods it has not received.
  const myItems = myAllItems.filter((sp) => !!sp.deliveredAt);
  const awaitingDelivery = myAllItems.length > 0 && myItems.length === 0;
  /**
   * 2026-07-30 (flow review) — the receiving check used to be a no-op.
   *
   * `allDecided` was literally `myItems.length > 0`: the name said "every
   * line has a verdict", the code said "there is at least one line". It
   * fed `mainBtnActive`, so 确认收货 was tappable the instant the page
   * opened. Paired with the old `it.confirmStatus ?? 'ok'` default (which
   * pre-selected the 正常 chip on every undecided row), a receiver could
   * sign off an entire delivery as received-and-correct without looking at
   * a single item — and nothing in the record distinguished "checked, fine"
   * from "never opened".
   *
   * Now: a line counts as decided only when the server actually holds a
   * `confirmStatus` for it. The chips render unselected until then, the
   * gate is stated on screen (progress row + main-button label), and
   * "全部标记正常" is an explicit, auditable bulk action instead of a
   * disguised default.
   */
  const decidedCount = myItems.filter((sp) => sp.confirmStatus != null).length;
  const undecided = myItems.filter((sp) => sp.confirmStatus == null);
  const allDecided = myItems.length > 0 && undecided.length === 0;
  // U4: what the receipt being confirmed says, for the summary sheet.
  const verdictCounts = countVerdicts(myItems);
  /** True once the store-level confirmation has actually landed. The
   *  Confirm Store button must hide AFTER this, otherwise repeated taps
   *  used to fire repeated `confirmStore.mutate` calls — the user
   *  reported tapping 5+ times before the UI caught up. */
  const storeConfirmed = myItems.length > 0 && myItems.every((s) => !!s.confirmedAt);
  // DLV-8 (2026-10-30): once signed, say so for as long as the page is
  // open (a toast was all there was) and stop offering the verdicts.
  const confirmedAt = storeConfirmed
    ? myItems.reduce<string | null>((latest, s) => {
        const at = s.confirmedAt ? String(s.confirmedAt) : null;
        return at && (!latest || at > latest) ? at : latest;
      }, null)
    : null;

  /**
   * Bulk "everything arrived correctly" is one server transaction now.
   * One request, one projection pass, and no half-marked store when the
   * connection drops mid-loop.
   */
  const markAllOk = () => {
    if (storeConfirmed || bulkMarkOk.isPending) return;
    if (!activeRun || !currentStoreId) return;
    if (undecided.length === 0) return;
    haptic('light');
    bulkMarkOk.mutate({
      runId: activeRun.id,
      storeId: currentStoreId,
      skuIds: undecided.map((it) => it.skuId),
    });
  };

  /** A chip on a line: 'ok' is sent at once, a problem opens its form. */
  const decide = (
    line: ConfirmLine & ReportedLine,
    sku: { unit: string } | undefined,
    status: ConfirmDecisionStatus,
  ) => {
    if (status !== 'ok') {
      issueForm.open(
        {
          runId: line.runId,
          skuId: line.skuId,
          storeId: line.storeId,
          status,
          splitQty: line.qty,
          unit: sku?.unit,
        },
        line,
      );
      return;
    }
    // Optimistic: paint the selection immediately so the user sees their
    // tap registered, then fire the mutation. A refusal refetches to roll
    // it back.
    const verdict = {
      runId: line.runId,
      skuId: line.skuId,
      storeId: line.storeId,
      status: 'ok' as const,
      note: null,
      photoUrl: null,
    };
    paintVerdict(verdict);
    confirmItem.mutate(verdict);
  };

  const issueCheck = issueForm.draft
    ? issueFormCheck(issueForm.draft, {
        photoUploading: issueForm.photoUploading,
        saving: confirmItem.isPending,
      })
    : null;
  /** One submit path for the sheet footer and the Telegram MainButton. */
  const submitIssue = () => {
    const draft = issueForm.draft;
    if (!draft || !issueCheck) return;
    issueForm.triedSave();
    if (!issueCheck.canSave) return;
    const verdict = {
      runId: draft.runId,
      skuId: draft.skuId,
      storeId: draft.storeId,
      status: draft.status,
      note: draft.note.trim(),
      photoUrl: draft.photo,
      receivedQty: issueCheck.received.ok ? issueCheck.received.value : null,
    };
    paintVerdict(verdict);
    confirmItem.mutate(verdict);
  };
  const submitConfirmStore = () => {
    if (!activeRun || !currentStoreId) return;
    if (storeConfirmed || confirmStore.isPending || !allDecided) return;
    confirmStore.mutate({ runId: activeRun.id, storeId: currentStoreId });
  };
  // The open problem form drives its Save; the summary sheet drives
  // 确认收货; otherwise the button opens that sheet.
  useConfirmMainButton(
    {
      issue: issueCheck,
      finalOpen: finalConfirmOpen,
      confirming: confirmStore.isPending,
      markingAll: bulkMarkOk.isPending,
      hasRun: !!activeRun,
      lineCount: myItems.length,
      undecided: undecided.length,
      storeConfirmed,
    },
    {
      saveIssue: submitIssue,
      submitConfirm: submitConfirmStore,
      openConfirm: () => {
        if (!activeRun || !currentStoreId) return;
        if (storeConfirmed || confirmStore.isPending) return;
        if (!allDecided) return;
        haptic('light');
        setFinalConfirmOpen(true);
      },
    },
  );
  const issueSku = issueForm.draft ? skuById.get(issueForm.draft.skuId) : undefined;

  if (!session) return null;
  if (!currentStoreId) {
    // Three modes:
    //   - storeCtx.kind === 'none' → user has no stores assigned at all
    //   - storeCtx.kind === 'all'  → admin viewing aggregate; this page
    //                                 needs a single store, prompt them
    //   - currentStoreId fell to null → same as 'none' for UX purposes
    return (
      /* M3.5: the inline store-picker strip is gone — the picker now
         lives in SettingsSheet, reachable via Telegram's gear button. */
      <div className="flex flex-col gap-3 pb-4">
        <div className="px-4 pt-3">
          {noStoreYet ? (
            <NoStoreYet />
          ) : storeCtx.kind === 'none' ? (
            <EmptyState
              title={i18n.t('auth.noStore.title')}
              description={i18n.t('auth.noStore.body')}
            />
          ) : (
            <EmptyState
              title={i18n.t('storeSwitcher.pickPrompt.title')}
              description={i18n.t('storeSwitcher.pickPrompt.body')}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    /* M3.5: the store-switcher pill moved to SettingsSheet. The sticky
       strip now only carries the run-date subtitle when there's an
       active run; without one, no chrome row. */
    <div className="flex flex-col gap-3 pb-4">
      {activeRun ? (
        <StickyPageBar className="min-h-7">
          {/* 2026-07-30: the receiver is signing for goods at a specific
              store — which the page never named. Now named once, in
              Shell's top strip, on every page including this one. */}
          <span className="ml-auto truncate text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('confirm.runOnDate', { date: dates.calendarDay(activeRun.runDate) })}
          </span>
        </StickyPageBar>
      ) : null}
      <PendingSyncNotice count={pendingChangeCount(offline.pendingEntries)} />
      <div className="flex flex-col gap-3 px-4">
        {runsView.kind === 'error' || (runsView.kind === 'ready' && runsView.stale) ? (
          <Banner
            tone="danger"
            title={i18n.t('common.error')}
            action={
              <Button
                variant="pearl"
                size="sm"
                loading={runsQuery.isFetching}
                onClick={() => void runsQuery.refetch()}
              >
                {i18n.t('common.retry')}
              </Button>
            }
          />
        ) : null}
        {/* 2026-10-21 CA-04: several deliveries waiting for this store —
            pick which one is being checked. Hidden in the common case of
            one. */}
        {candidateRuns.length > 1 ? (
          <ChipBar variant="radio" ariaLabel={i18n.t('confirm.runPicker.ariaLabel')}>
            {candidateRuns.map((r) => (
              <Chip
                key={r.id}
                selected={r.id === activeRun?.id}
                onClick={() => {
                  if (issueForm.draft) return;
                  haptic('light');
                  setPickedRunId(r.id);
                }}
              >
                {/* Review CONF-20: a run this store signed for says so in
                    words; a bare ✓ said nothing to a screen reader. */}
                {i18n.t(
                  storeConfirmedByRun.get(r.id)
                    ? 'confirm.runPicker.optionConfirmed'
                    : 'confirm.runPicker.option',
                  { n: r.runIndex + 1, date: dates.calendarDay(r.runDate) },
                )}
              </Chip>
            ))}
          </ChipBar>
        ) : null}
        {runsView.kind === 'loading' ? (
          <LoadingState />
        ) : runsView.kind === 'offline' ? (
          <OfflineState />
        ) : runsView.kind === 'error' ? null : !activeRun ? (
          <ReceivingWaitState wait={wait} />
        ) : (
          <DataState query={detailQuery}>
            {() => (
              <>
                {!myItems.length ? (
                  awaitingDelivery ? (
                    <ReceivingWaitState wait={wait} />
                  ) : unbought.length > 0 ? (
                    // Everything this store ordered on the run was not found.
                    <EmptyState
                      title={i18n.t('confirm.unbought.allTitle')}
                      description={i18n.t('confirm.unbought.hint')}
                    />
                  ) : (
                    <EmptyState title={i18n.t('confirm.empty.noItems')} />
                  )
                ) : (
                  <Card>
                    {/* UIUX-B1 (2026-07-06): CardHeader/CardTitle deleted —
                      this is the sole card on the screen and the nav tab
                      already names the job (same reasoning M1.11 used to
                      drop the hint CardMeta).

                      2026-07-30 (flow review): a progress row comes back,
                      but carrying the one thing the deleted chrome never
                      did — the GATE. It states how many lines still need a
                      verdict and offers the honest fast path next to it, so
                      "everything arrived fine" is one deliberate tap rather
                      than a pre-ticked default. */}
                    {!storeConfirmed ? (
                      <div className="flex items-center justify-between gap-3 border-b border-[var(--c-divider)] px-4 py-2">
                        <span
                          className={
                            'text-old-label font-semibold tabular-nums ' +
                            (allDecided ? 'text-[var(--c-fg-muted)]' : 'text-[var(--c-warning-fg)]')
                          }
                        >
                          {i18n.t('confirm.progress', {
                            done: decidedCount,
                            total: myItems.length,
                          })}
                        </span>
                        {!allDecided ? (
                          <Button
                            size="sm"
                            variant="pearl"
                            loading={bulkMarkOk.isPending}
                            onClick={() => setBulkConfirmOpen(true)}
                          >
                            {i18n.t('confirm.markAllOk')}
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      confirmQueued ? (
                        // R2-DLV-3: confirmed offline — saved, not yet sent.
                        <div
                          data-testid="confirm-queued"
                          className="border-b border-[var(--c-divider)] px-4 py-2 text-old-label font-semibold text-[var(--c-warning-fg)]"
                        >
                          {i18n.t('confirm.queued')}
                        </div>
                      ) : (
                        <div className="border-b border-[var(--c-divider)] px-4 py-2 text-old-label font-semibold text-[var(--c-success)]">
                          {i18n.t('confirm.storeConfirmedAt', { time: dates.dateTime(confirmedAt) })}
                        </div>
                      )
                    )}
                    <ul className="flex flex-col" role="list">
                      {myItems.map((it) => {
                        const sku = skuById.get(it.skuId);
                        return (
                          <ConfirmItemRow
                            key={`${it.runId}:${it.skuId}`}
                            line={it}
                            sku={sku}
                            locked={storeConfirmed}
                            onDecide={(status) => decide(it, sku, status)}
                          />
                        );
                      })}
                    </ul>
                    {/* UIUX-B1 (2026-07-06): inline Confirm-Store button
                      deleted — it duplicated the PageMainButton's exact
                      mutation and doubled the double-tap surface the
                      storeConfirmed guard exists to fight. One CTA. */}
                  </Card>
                )}
                {unbought.length > 0 ? (
                  <UnboughtCard
                    items={unbought}
                    skuById={skuById}
                    showHint={myItems.length > 0 || awaitingDelivery}
                  />
                ) : null}
              </>
            )}
          </DataState>
        )}
      </div>

      <ConfirmSheet
        open={finalConfirmOpen && !storeConfirmed}
        title={i18n.t('confirm.final.title')}
        banner={
          <div className="flex flex-col gap-2">
            <ul
              data-testid="confirm-final-summary"
              role="list"
              className="flex flex-wrap gap-x-4 gap-y-1 text-old-body font-semibold tabular-nums text-[var(--c-fg)]"
            >
              {verdictSummaryParts(verdictCounts).map((part) => (
                <li key={part.key}>{i18n.t(part.key, { n: part.n })}</li>
              ))}
            </ul>
            {verdictCounts.short > 0 ? (
              <Banner
                tone="warn"
                title={i18n.t('confirm.final.shortWarning', { n: verdictCounts.short })}
              />
            ) : null}
          </div>
        }
        body={i18n.t('confirm.final.body')}
        confirmLabel={i18n.t('confirm.final.submit')}
        // DX-IX-6: confirming locks the receipt; start on Cancel.
        irreversible
        cancelLabel={i18n.t('common.cancel')}
        pending={confirmStore.isPending}
        onConfirm={submitConfirmStore}
        onCancel={() => {
          if (!confirmStore.isPending) setFinalConfirmOpen(false);
        }}
      />

      <Sheet
        open={bulkConfirmOpen}
        onOpenChange={(open) => {
          if (!open && bulkMarkOk.isPending) return;
          setBulkConfirmOpen(open);
        }}
        title={i18n.t('confirm.bulk.title', { n: undecided.length })}
        description={i18n.t('confirm.bulk.body')}
        footer={
          <Button
            block
            size="lg"
            loading={bulkMarkOk.isPending}
            disabled={undecided.length === 0}
            onClick={markAllOk}
          >
            {i18n.t('confirm.bulk.submit', { n: undecided.length })}
          </Button>
        }
      >
        <div className="py-3 text-old-body-sm text-[var(--c-fg-muted)]">
          {i18n.t('confirm.bulk.hint', { n: undecided.length })}
        </div>
      </Sheet>

      <IssueSheet
        form={issueForm}
        check={issueCheck}
        saving={confirmItem.isPending}
        itemName={issueSku ? productNameParts(issueSku).primary : undefined}
        photoUploader={photoUploader}
        onSave={submitIssue}
      />
    </div>
  );
}
