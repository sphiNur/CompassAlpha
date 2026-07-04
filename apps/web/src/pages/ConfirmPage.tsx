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
import { useMemo, useState } from 'react';
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  Chip,
  ChipBar,
  DataState,
  EmptyState,
  NameCell,
  PhotoCapture,
  Sheet,
  StickyPageBar,
  Input,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { useI18n, useProductNameParts } from '../hooks/useI18n';
import { usePhotoUploader } from '../hooks/usePhotoUploader';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { formatQty } from '../lib/format';
import { useStoreContext } from '../components/StoreSwitcher';

type DecisionStatus = 'ok' | 'short' | 'wrong' | 'quality';

export function ConfirmPage() {
  const i18n = useI18n();
  const productNameParts = useProductNameParts();
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
  } | null>(null);
  const [issueNote, setIssueNote] = useState('');
  const [issuePhoto, setIssuePhoto] = useState<string | null>(null);
  const photoUploader = usePhotoUploader('issue');

  const runsQuery = trpc.run.list.useQuery();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const utils = trpc.useUtils();
  // Receivers also confirm from inside the store, often with terrible
  // wifi. Same offline-replay treatment as the purchaser side.
  const offline = useOfflineQueue({
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
  }, { onDrop: () => toast.error(i18n.t('run.toast.syncFailed')) });

  const activeRun = useMemo(
    () => runsQuery.data?.find((r) => r.status === 'delivering') ?? null,
    [runsQuery.data],
  );
  const detailQuery = trpc.run.get.useQuery(
    activeRun ? { runId: activeRun.id } : { runId: '' },
    { enabled: !!activeRun },
  );

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
  ) => {
    utils.run.get.setData({ runId }, (old) => {
      if (!old) return old;
      const splits = old.splits.map((sp) =>
        sp.runId === runId && sp.skuId === skuId && sp.storeId === storeId
          ? { ...sp, confirmStatus: status, confirmNote: note, confirmPhotoUrl: photoUrl }
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
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.confirmStoreItem', vars);
        setIssueOpen(null);
        setIssueNote('');
        setIssuePhoto(null);
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

  const myItems = (detailQuery.data?.splits ?? []).filter(
    (sp) => sp.storeId === currentStoreId,
  );
  const allDecided = myItems.length > 0;
  const decidedCount = myItems.length;
  /** True once the store-level confirmation has actually landed. The
   *  Confirm Store button must hide AFTER this, otherwise repeated taps
   *  used to fire repeated `confirmStore.mutate` calls — the user
   *  reported tapping 5+ times before the UI caught up. */
  const storeConfirmed = myItems.length > 0 && myItems.every((s) => !!s.confirmedAt);

  // MainButton dispatch — when the issue sheet is open it takes over
  // and drives Save. Otherwise it acts as Confirm Store.
  const issueReasonOk = !!issueOpen && issueNote.trim().length > 0;
  let mainBtnText: string;
  let mainBtnVisible = false;
  let mainBtnActive = false;
  let mainBtnClick = () => {};
  if (issueOpen) {
    mainBtnText = i18n.t('confirm.issue.save');
    mainBtnVisible = true;
    mainBtnActive = issueReasonOk && !confirmItem.isPending;
    mainBtnClick = () => {
      if (!issueOpen || !issueReasonOk || confirmItem.isPending) return;
      writeOptimisticItemConfirm(
        issueOpen.runId,
        issueOpen.skuId,
        issueOpen.storeId,
        issueOpen.status,
        issueNote.trim(),
        issuePhoto,
      );
      confirmItem.mutate({
        runId: issueOpen.runId,
        skuId: issueOpen.skuId,
        storeId: issueOpen.storeId,
        status: issueOpen.status,
        note: issueNote.trim(),
        photoUrl: issuePhoto,
      });
    };
  } else {
    mainBtnText = storeConfirmed
      ? i18n.t('confirm.confirmStoreFinal')
      : confirmStore.isPending
        ? i18n.t('confirm.confirmingHint')
        : i18n.t('confirm.confirmStore', {
            decided: decidedCount,
            total: myItems.length,
          });
    mainBtnVisible = !!activeRun && myItems.length > 0 && !storeConfirmed;
    mainBtnActive = allDecided && !confirmStore.isPending;
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
          <span className="ml-auto truncate text-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('confirm.runOnDate', { date: activeRun.runDate })}
          </span>
        </StickyPageBar>
      ) : null}
      <div className="flex flex-col gap-3 px-4">

      {!activeRun ? (
        <EmptyState
          title={i18n.t('confirm.empty.nothingToConfirm')}
          description={i18n.t('confirm.empty.nothingDesc')}
        />
      ) : (
        <DataState query={detailQuery}>
          {() => (
            <>
              {!myItems.length ? (
                <EmptyState title={i18n.t('confirm.empty.noItems')} />
              ) : (
                <Card>
                  {/* M1.11 cleanup: dropped the
                      `confirm.deliveredItemsHint` CardMeta — the
                      visible chip-bar per item makes "tap a status"
                      self-evident. */}
                  <CardHeader>
                    <CardTitle>{i18n.t('confirm.deliveredItems')}</CardTitle>
                  </CardHeader>
                  <ul className="flex flex-col" role="list">
                    {myItems.map((it) => {
                      const sku = skuById.get(it.skuId);
                      const nm = sku ? productNameParts(sku) : null;
                      const effectiveStatus = (it.confirmStatus ?? 'ok') as DecisionStatus;
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
                            <span className="shrink-0 font-mono text-label tabular-nums text-[var(--c-fg-muted)]">
                              {formatQty(it.qty)} {sku?.unit ?? ''}
                            </span>
                          </div>
                          <ChipBar>
                            {(['ok', 'short', 'wrong', 'quality'] as DecisionStatus[]).map((s) => (
                              <Chip
                                key={s}
                                aria-label={i18n.t(('confirm.status.' + s) as Parameters<typeof i18n.t>[0])}
                                selected={effectiveStatus === s}
                                onClick={() => {
                                  // Block any further taps once the
                                  // store side has been finalized.
                                  // After StoreConfirmed, the API will
                                  // reject confirmStoreItem anyway; we
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
                                    });
                                  }
                                }}
                              >
                                {/* M1.9-fix (2026-05-07): chip labels were
                                    rendering the raw enum values (ok/short/
                                    wrong/quality) — every non-English user
                                    saw English on the most-tapped UI on the
                                    page. Map to i18n keys keyed by enum. */}
                                {i18n.t(('confirm.status.' + s) as Parameters<typeof i18n.t>[0])}
                              </Chip>
                            ))}
                          </ChipBar>
                          {it.confirmNote ? (
                            <div className="text-label text-[var(--c-fg-muted)]">{it.confirmNote}</div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {storeConfirmed ? null : (
                    // M3.49 (2026-05-23): dropped the `!getTg()` check.
                    // The in-page PageMainButton in Shell now drives
                    // the canonical CTA, but this inline button is the
                    // fallback when no sheet is involved and the user
                    // wants a visible CTA inline (e.g., per-store
                    // section). Both render — the inline button is
                    // contextually clearer here.
                    <div className="px-4 py-3">
                      <Button
                        block
                        disabled={!allDecided || confirmStore.isPending}
                        loading={confirmStore.isPending}
                        onClick={() => {
                          if (storeConfirmed || confirmStore.isPending) return;
                          confirmStore.mutate({
                            runId: activeRun.id,
                            storeId: currentStoreId,
                          });
                        }}
                      >
                        {i18n.t('confirm.confirmStore', {
                          decided: decidedCount,
                          total: myItems.length,
                        })}
                      </Button>
                    </div>
                  )}
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
          if (!open) setIssueOpen(null);
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
            disabled={!issueNote.trim() || confirmItem.isPending}
            loading={confirmItem.isPending}
            onClick={() => {
              if (!issueOpen || confirmItem.isPending) return;
              writeOptimisticItemConfirm(
                issueOpen.runId,
                issueOpen.skuId,
                issueOpen.storeId,
                issueOpen.status,
                issueNote.trim(),
                issuePhoto,
              );
              confirmItem.mutate({
                runId: issueOpen.runId,
                skuId: issueOpen.skuId,
                storeId: issueOpen.storeId,
                status: issueOpen.status,
                note: issueNote.trim(),
                photoUrl: issuePhoto,
              });
            }}
          >
            {i18n.t('confirm.issue.save')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
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
