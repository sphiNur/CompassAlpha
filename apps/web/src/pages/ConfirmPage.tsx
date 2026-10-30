/**
 * ConfirmPage — store-side acceptance.
 *
 * Lists items delivered to my current store across all in-flight runs, lets
 * the receiver mark each item ok / short / wrong / quality. When all are
 * decided, a Confirm Store button finalizes the store side.
 *
 * For M1 the photo capture stub is a text URL; full S3 upload + image picker
 * lands in M1 follow-ups (PhotoCapture component).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  Card,
  Chip,
  ChipBar,
  DataState,
  EmptyState,
  NameCell,
  PhotoCapture,
  Sheet,
  StickyPageBar,
  Input,
  Spinner,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { useDateFormat, useI18n, useProductNameParts, useUnitLabel } from '../hooks/useI18n';
import { usePhotoUploader } from '../hooks/usePhotoUploader';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { formatQty } from '../lib/format';
import { useStoreContext } from '../components/StoreSwitcher';
import {
  checkReceivedQty,
  defaultDeliveringRunId,
  deliveringRunsForStore,
  initialReceivedQty,
  runsListView,
  type ConfirmDecisionStatus,
} from './confirm/confirmLogic';

type DecisionStatus = ConfirmDecisionStatus;

export function ConfirmPage() {
  const i18n = useI18n();
  const dates = useDateFormat();
  const productNameParts = useProductNameParts();
  // 2026-07-30 (flow review): the receiving list printed the raw canonical
  // unit ("kg") while Run — the screen the goods just came from — printed
  // "公斤". Same goods, same locale, two spellings.
  const unitLabel = useUnitLabel();
  const session = useAuthStore((s) => s.session);
  // ConfirmPage needs a SPECIFIC store — staff confirm receipt at THEIR
  // store. Reading via the context helper coerces 'all' to null so the
  // pick-a-store empty-state takes over (added 2026-05-05).
  const storeCtx = useStoreContext();
  const currentStoreId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const toast = useToast();
  const errToast = useErrToast();
  const [issueOpen, setIssueOpen] = useState<{
    runId: string;
    skuId: string;
    storeId: string;
    status: DecisionStatus;
    /** 2026-10-21 CA-06: this store's split qty — the received-qty ceiling. */
    splitQty: string;
    unit: string | undefined;
  } | null>(null);
  const [issueNote, setIssueNote] = useState('');
  // 2026-10-21 CA-06: how much of the split actually arrived. Empty for
  // 'short' (must be typed), "0" for 'wrong' / 'quality'.
  const [issueReceived, setIssueReceived] = useState('');
  const [issuePhoto, setIssuePhoto] = useState<string | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const photoUploader = usePhotoUploader('issue');

  const runsQuery = trpc.run.list.useQuery();
  // 2026-10-21 FE-01 / F4-02: loading / failed run.list must not render as
  // "nothing to confirm".
  const runsView = runsListView({
    isLoading: runsQuery.isLoading,
    isError: runsQuery.isError,
    hasData: runsQuery.data !== undefined,
  });
  // CAT-7 (2026-10-30): include archived products so lines already ordered,
  // approved or bought still show their name and unit (they showed as an id
  // fragment, or not at all). Pickers filter archived ones out.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  const utils = trpc.useUtils();
  // Receivers also confirm from inside the store, often with terrible
  // wifi. Same offline-replay treatment as the purchaser side.
  const offline = useOfflineQueue(
    {
      'run.confirmStoreItem': async (entry) => {
        await utils.client.run.confirmStoreItem.mutate(
          entry.input as Parameters<typeof utils.client.run.confirmStoreItem.mutate>[0],
        );
        void utils.run.get.invalidate();
      },
      'run.confirmStore': async (entry) => {
        await utils.client.run.confirmStore.mutate(
          entry.input as Parameters<typeof utils.client.run.confirmStore.mutate>[0],
        );
        void utils.run.get.invalidate();
      },
      'run.markStoreItemsOk': async (entry) => {
        await utils.client.run.markStoreItemsOk.mutate(
          entry.input as Parameters<typeof utils.client.run.markStoreItemsOk.mutate>[0],
        );
        void utils.run.get.invalidate();
      },
    },
    { onDrop: () => toast.error(i18n.t('run.toast.syncFailed')) },
  );

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
  const detailQuery = trpc.run.get.useQuery(activeRun ? { runId: activeRun.id } : { runId: '' }, {
    enabled: !!activeRun,
  });

  const skuById = useMemo(() => {
    const m = new Map<string, { names: Record<string, string>; unit: string }>();
    for (const s of skusQuery.data ?? []) {
      m.set(s.id, { names: s.names as Record<string, string>, unit: s.unit });
    }
    return m;
  }, [skusQuery.data]);

  /**
   * Optimistic cache writer: paint the chip selection BEFORE the
   * server roundtrip. The user reported the previous version:
   *
   *   tap "ok" → no visible change for ~400ms (CN ↔ Tashkent RTT)
   *           → tap "ok" again, and again, and again
   *           → server appended FOUR identical StoreItemConfirmed events
   *
   * Now: chip flips selected immediately on tap; if the server later
   * rejects, we invalidate to snap back to truth.
   */
  const writeOptimisticItemConfirm = (
    runId: string,
    skuId: string,
    storeId: string,
    status: DecisionStatus,
    note: string | null,
    photoUrl: string | null,
    receivedQty: string | null = null,
  ) => {
    utils.run.get.setData({ runId }, (old) => {
      if (!old) return old;
      const splits = old.splits.map((sp) =>
        sp.runId === runId && sp.skuId === skuId && sp.storeId === storeId
          ? {
              ...sp,
              confirmStatus: status,
              confirmNote: note,
              confirmPhotoUrl: photoUrl,
              confirmReceivedQty: receivedQty,
            }
          : sp,
      );
      return { ...old, splits };
    });
  };

  const confirmItem = trpc.run.confirmStoreItem.useMutation({
    onSuccess: (_data, vars) => {
      void utils.run.get.invalidate();
      setIssueOpen(null);
      setIssueNote('');
      setIssuePhoto(null);
      setIssueReceived('');
      // Bug fix: previously this said "Issue noted" for EVERY confirm,
      // including the most common "ok" case — confusing. The toast now
      // matches what actually happened.
      //
      if (vars.status === 'ok') {
        haptic('success');
        toast.success(i18n.t('confirm.toast.markedOk'));
      } else {
        haptic('warning');
        toast.info(i18n.t('confirm.toast.issueNoted'));
      }
    },
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.confirmStoreItem', vars);
        setIssueOpen(null);
        setIssueNote('');
        setIssuePhoto(null);
        setIssueReceived('');
        toast.info(i18n.t('confirm.toast.savedOffline'));
      } else {
        // Roll back the optimistic write since the server refused it.
        void utils.run.get.invalidate();
        errToast('common.error')(err);
      }
    },
  });
  const confirmStore = trpc.run.confirmStore.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      haptic('success');
      toast.success(i18n.t('confirm.toast.storeConfirmed'));
    },
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.confirmStore', vars);
        toast.info(i18n.t('confirm.toast.savedOffline'));
      } else {
        errToast('common.error')(err);
      }
    },
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
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.markStoreItemsOk', vars);
        setBulkConfirmOpen(false);
        toast.info(i18n.t('confirm.toast.savedOffline'));
      } else {
        errToast('common.error')(err);
      }
    },
  });

  const myAllItems = (detailQuery.data?.splits ?? []).filter((sp) => sp.storeId === currentStoreId);
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

  // MainButton dispatch — when the issue sheet is open it takes over
  // and drives Save. Otherwise it acts as Confirm Store.
  const issueReceivedCheck = issueOpen
    ? checkReceivedQty(issueOpen.status, issueReceived, issueOpen.splitQty)
    : null;
  const issueReasonOk =
    !!issueOpen && issueNote.trim().length > 0 && issueReceivedCheck?.ok === true;
  /** One submit path for the sheet footer and the Telegram MainButton. */
  const submitIssue = () => {
    if (!issueOpen || !issueReasonOk || confirmItem.isPending) return;
    const receivedQty = issueReceivedCheck?.ok ? issueReceivedCheck.value : null;
    writeOptimisticItemConfirm(
      issueOpen.runId,
      issueOpen.skuId,
      issueOpen.storeId,
      issueOpen.status,
      issueNote.trim(),
      issuePhoto,
      receivedQty,
    );
    confirmItem.mutate({
      runId: issueOpen.runId,
      skuId: issueOpen.skuId,
      storeId: issueOpen.storeId,
      status: issueOpen.status,
      note: issueNote.trim(),
      photoUrl: issuePhoto,
      receivedQty,
    });
  };
  let mainBtnText: string;
  let mainBtnVisible = false;
  let mainBtnActive = false;
  let mainBtnClick = () => {};
  if (issueOpen) {
    mainBtnText = i18n.t('confirm.issue.save');
    mainBtnVisible = true;
    mainBtnActive = issueReasonOk && !confirmItem.isPending;
    mainBtnClick = submitIssue;
  } else {
    // 2026-07-30: when the gate is closed, SAY so on the button instead of
    // showing an inert "确认收货". The comment where the gating banner used
    // to live claimed a "Decided X/Y" counter, a card-meta hint and a
    // disabled MainButton already conveyed this — all three had since been
    // deleted or broken, so the gate was invisible AND never actually shut.
    mainBtnText = storeConfirmed
      ? i18n.t('confirm.confirmStoreFinal')
      : confirmStore.isPending
        ? i18n.t('confirm.confirmingHint')
        : allDecided
          ? i18n.t('confirm.confirmStore')
          : i18n.t('confirm.confirmStoreBlocked', { n: undecided.length });
    mainBtnVisible = !!activeRun && myItems.length > 0 && !storeConfirmed;
    mainBtnActive = allDecided && !confirmStore.isPending && !bulkMarkOk.isPending;
    mainBtnClick = () => {
      if (!activeRun || !currentStoreId) return;
      if (storeConfirmed || confirmStore.isPending) return;
      if (!allDecided) return;
      confirmStore.mutate({ runId: activeRun.id, storeId: currentStoreId });
    };
  }
  usePageMainButton(mainBtnText, mainBtnClick, {
    visible: mainBtnVisible,
    active: mainBtnActive,
  });

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
          {storeCtx.kind === 'none' ? (
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
            {i18n.t('confirm.runOnDate', { date: activeRun.runDate })}
          </span>
        </StickyPageBar>
      ) : null}
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
                  if (issueOpen) return;
                  haptic('light');
                  setPickedRunId(r.id);
                }}
              >
                {i18n.t('confirm.runPicker.option', { n: r.runIndex + 1, date: r.runDate })}
                {storeConfirmedByRun.get(r.id) ? ' ✓' : ''}
              </Chip>
            ))}
          </ChipBar>
        ) : null}
        {runsView.kind === 'loading' ? (
          <div className="flex items-center justify-center py-12 text-[var(--c-fg-muted)]">
            <Spinner size={28} />
          </div>
        ) : runsView.kind === 'error' ? null : !activeRun ? (
          <EmptyState
            title={i18n.t('confirm.empty.nothingToConfirm')}
            description={i18n.t('confirm.empty.nothingDesc')}
          />
        ) : (
          <DataState query={detailQuery}>
            {() => (
              <>
                {!myItems.length ? (
                  awaitingDelivery ? (
                    <EmptyState
                      title={i18n.t('confirm.empty.nothingToConfirm')}
                      description={i18n.t('confirm.empty.nothingDesc')}
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
                      <div className="border-b border-[var(--c-divider)] px-4 py-2 text-old-label font-semibold text-[var(--c-success)]">
                        {i18n.t('confirm.storeConfirmedAt', { time: dates.dateTime(confirmedAt) })}
                      </div>
                    )}
                    <ul className="flex flex-col" role="list">
                      {myItems.map((it) => {
                        const sku = skuById.get(it.skuId);
                        const nm = sku ? productNameParts(sku) : null;
                        // 2026-07-30 (flow review): was `it.confirmStatus ?? 'ok'`,
                        // which pre-selected 正常 on every untouched line. The
                        // receiver's screen therefore OPENED in the state
                        // "everything is fine" — the exact claim the step exists
                        // to obtain from them. null now means null: no chip is
                        // selected until they choose one.
                        const effectiveStatus = it.confirmStatus as DecisionStatus | null;
                        return (
                          <li
                            key={`${it.runId}:${it.skuId}`}
                            className="flex flex-col gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0"
                          >
                            <div className="flex items-start justify-between gap-3">
                              {/* Confirm is the "default" (dense) name tier
                                per the 2026-07-05 two-tier decision. */}
                              <NameCell
                                primary={nm ? nm.primary : it.skuId.slice(0, 8)}
                                secondary={nm?.secondary}
                                size="default"
                              />
                              <span className="shrink-0 font-mono text-old-label tabular-nums text-[var(--c-fg-muted)]">
                                {formatQty(it.qty)} {unitLabel(sku?.unit)}
                              </span>
                            </div>
                            {/* variant="radio" (2026-07-30): now that an
                              undecided line selects NOTHING, a tablist
                              with no selected tab would be invalid ARIA.
                              A radiogroup with nothing checked is exactly
                              the state we mean. */}
                            <ChipBar variant="radio" ariaLabel={i18n.t('confirm.status.ariaLabel')}>
                              {(['ok', 'short', 'wrong', 'quality'] as DecisionStatus[]).map(
                                (s) => (
                                  <Chip
                                    key={s}
                                    aria-label={i18n.t(
                                      ('confirm.status.' + s) as Parameters<typeof i18n.t>[0],
                                    )}
                                    selected={effectiveStatus === s}
                                    disabled={storeConfirmed}
                                    className={storeConfirmed && effectiveStatus !== s ? 'opacity-40' : undefined}
                                    onClick={() => {
                                      // Block any further taps once the
                                      // store side has been finalized.
                                      // After StoreConfirmed the API
                                      // rejects confirmStoreItem
                                      // (storeAlreadyConfirmed, since the
                                      // 2026-10-21 audit CA-30 guard); we
                                      // catch it here so the UI doesn't
                                      // even try.
                                      if (storeConfirmed) return;
                                      // Block double-tap on the SAME chip —
                                      // the domain will return [] but we
                                      // save the round-trip entirely.
                                      if (effectiveStatus === s) return;
                                      haptic('light');
                                      if (s === 'ok') {
                                        // Optimistic: paint the selection
                                        // immediately so the user sees
                                        // their tap registered, then fire
                                        // the mutation. onError invalidates
                                        // to roll back if the server
                                        // refuses.
                                        writeOptimisticItemConfirm(
                                          it.runId,
                                          it.skuId,
                                          it.storeId,
                                          'ok',
                                          null,
                                          null,
                                        );
                                        confirmItem.mutate({
                                          runId: it.runId,
                                          skuId: it.skuId,
                                          storeId: it.storeId,
                                          status: 'ok',
                                          note: null,
                                          photoUrl: null,
                                        });
                                      } else {
                                        setIssueOpen({
                                          runId: it.runId,
                                          skuId: it.skuId,
                                          storeId: it.storeId,
                                          status: s,
                                          splitQty: it.qty,
                                          unit: sku?.unit,
                                        });
                                        setIssueReceived(
                                          initialReceivedQty(
                                            s,
                                            it.confirmStatus === s ? it.confirmReceivedQty : null,
                                          ),
                                        );
                                      }
                                    }}
                                  >
                                    {/* M1.9-fix (2026-05-07): chip labels were
                                    rendering the raw enum values (ok/short/
                                    wrong/quality) — every non-English user
                                    saw English on the most-tapped UI on the
                                    page. Map to i18n keys keyed by enum. */}
                                    {i18n.t(
                                      ('confirm.status.' + s) as Parameters<typeof i18n.t>[0],
                                    )}
                                  </Chip>
                                ),
                              )}
                            </ChipBar>
                            {/* 2026-10-21 CA-06: what was booked into stock
                                for a problem line. */}
                            {effectiveStatus &&
                            effectiveStatus !== 'ok' &&
                            it.confirmReceivedQty != null ? (
                              <div className="text-old-label font-medium tabular-nums text-[var(--c-warning-fg)]">
                                {i18n.t(
                                  ('confirm.status.' + effectiveStatus) as Parameters<
                                    typeof i18n.t
                                  >[0],
                                )}
                                {' · '}
                                {i18n.t('confirm.receivedOf', {
                                  received: formatQty(it.confirmReceivedQty),
                                  qty: formatQty(it.qty),
                                  unit: unitLabel(sku?.unit),
                                })}
                              </div>
                            ) : null}
                            {it.confirmNote ? (
                              <div className="text-old-label text-[var(--c-fg-muted)]">
                                {it.confirmNote}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    {/* UIUX-B1 (2026-07-06): inline Confirm-Store button
                      deleted — it duplicated the PageMainButton's exact
                      mutation and doubled the double-tap surface the
                      storeConfirmed guard exists to fight. One CTA. */}
                  </Card>
                )}
              </>
            )}
          </DataState>
        )}
      </div>

      {/* Banner removed — the "Decided X/Y" counter at the top + the
          card meta "Tap a status for each item" + the disabled
          MainButton already convey the same gating. The redundant
          banner was visual clutter. */}

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

      <Sheet
        open={!!issueOpen}
        onOpenChange={(open) => {
          // M3.10: pin the sheet open while a confirm mutation is in
          // flight. The receiver may have typed an issue note + attached
          // a photo; if the network is slow and they swipe-down, the
          // local state (issueOpen / issueNote / issuePhoto) clears and
          // a subsequent failure produces an error toast with all that
          // work lost. Mutation success closes the sheet naturally via
          // confirmItem.onSuccess setIssueOpen(null).
          if (!open && confirmItem.isPending) return;
          // 2026-10-21 audit C-20: drop the draft on cancel too — it used
          // to be cleared only on success, so a cancelled note/photo
          // reappeared on the next item's issue sheet.
          if (!open) {
            setIssueOpen(null);
            setIssueNote('');
            setIssuePhoto(null);
            setIssueReceived('');
          }
        }}
        title={i18n.t('confirm.issue.markAs', {
          status: issueOpen
            ? i18n.t(('confirm.status.' + issueOpen.status) as Parameters<typeof i18n.t>[0])
            : '',
        })}
        description={i18n.t('confirm.issue.describe')}
        // M1.9-fix (2026-05-07): autofocusing the issue note input
        // popped the iOS keyboard mid-slideUp, pushing the
        // PhotoCapture row below the fold. Receiver who wants to
        // attach a photo first now sees both inputs.
        disableAutoFocus
        footer={
          // M3.49 (2026-05-23): dropped !getTg() — the in-page
          // PageMainButton sits behind any open sheet, so we
          // ALWAYS render the sheet's own footer button now.
          <Button
            block
            disabled={!issueReasonOk || confirmItem.isPending}
            loading={confirmItem.isPending}
            onClick={submitIssue}
          >
            {i18n.t('confirm.issue.save')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {/* 2026-10-21 CA-06: inventory books what actually arrived.
              Required for a short line; 0 by default for a wrong or
              spoiled item (nothing usable arrived) and editable. */}
          {issueOpen ? (
            <div className="flex flex-col gap-1">
              <Input
                type="text"
                inputMode="decimal"
                value={issueReceived}
                onChange={(e) => setIssueReceived(e.target.value)}
                placeholder={i18n.t('confirm.issue.receivedQty', {
                  max: formatQty(issueOpen.splitQty),
                  unit: unitLabel(issueOpen.unit),
                })}
                aria-label={i18n.t('confirm.issue.receivedQty', {
                  max: formatQty(issueOpen.splitQty),
                  unit: unitLabel(issueOpen.unit),
                })}
              />
              {issueReceivedCheck && !issueReceivedCheck.ok ? (
                <span className="text-old-label text-[var(--c-warning-fg)]">
                  {issueReceivedCheck.reason === 'required'
                    ? i18n.t('confirm.issue.receivedQtyRequired')
                    : issueReceivedCheck.reason === 'notShort'
                      ? i18n.t('confirm.issue.receivedQtyNotShort', {
                          max: formatQty(issueOpen.splitQty),
                        })
                      : i18n.t('confirm.issue.receivedQtyRange', {
                        max: formatQty(issueOpen.splitQty),
                      })}
                </span>
              ) : null}
            </div>
          ) : null}
          <Input
            value={issueNote}
            onChange={(e) => setIssueNote(e.target.value)}
            placeholder={i18n.t('confirm.issue.placeholder')}
            maxLength={500}
          />
          <PhotoCapture
            label={i18n.t('confirm.issue.photoOptional')}
            value={issuePhoto}
            onCapture={(url) => setIssuePhoto(url)}
            onClear={() => setIssuePhoto(null)}
            uploader={photoUploader}
          />
        </div>
      </Sheet>
    </div>
  );
}
