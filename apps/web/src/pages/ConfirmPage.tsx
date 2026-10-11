/**
 * Receiving: what was delivered to this store, checked in.
 *
 * Nearly every delivery arrives complete, so the screen's one button says
 * so in a tap. A line with something wrong is opened and marked first;
 * the button then reads "Confirm, 1 with a problem".
 *
 * Each line still gets its own recorded verdict. Pressing the button
 * writes "OK" for every line not yet looked at and then confirms the
 * store, so the record distinguishes "said to be fine" from "never
 * asked", which an implicit default did not.
 */
import { useMemo, useRef, useState } from 'react';
import { DataState, useToast } from '@compass/ui';
import { Button, EmptyState, Field, List, Row, Section, Sheet, StatusChip } from '@compass/ui/kit';
import type { StatusTone } from '@compass/ui/kit';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { useI18n, useProductName, useUnitLabel } from '../hooks/useI18n';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { formatQty } from '../lib/format';
import { useStoreContext } from '../components/StoreSwitcher';

type DecisionStatus = 'ok' | 'short' | 'wrong' | 'quality';
const STATUSES: DecisionStatus[] = ['ok', 'short', 'wrong', 'quality'];
const TONE: Record<DecisionStatus, StatusTone> = {
  ok: 'done',
  short: 'problem',
  wrong: 'problem',
  quality: 'problem',
};

export function ConfirmPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const unitLabel = useUnitLabel();
  const session = useAuthStore((s) => s.session);
  // Receiving is done at one store; "all stores" has nothing to check in.
  const storeCtx = useStoreContext();
  const currentStoreId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const toast = useToast();
  const errToast = useErrToast();
  /** The line whose verdict is being chosen, and the verdict so far. */
  const [openSku, setOpenSku] = useState<string | null>(null);
  const [choice, setChoice] = useState<DecisionStatus>('ok');
  const [note, setNote] = useState('');
  // One summary toast for the whole delivery instead of one per line. A
  // ref, because the mutation's onSuccess reads it outside a render.
  const [receiving, setReceiving] = useState(false);
  const bulkRef = useRef(false);

  const runsQuery = trpc.run.list.useQuery(undefined, { refetchOnMount: 'always' });
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
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
    },
    { onDrop: () => toast.error(i18n.t('run.toast.syncFailed')) },
  );

  const activeRun = useMemo(
    () => runsQuery.data?.find((r) => r.status === 'delivering') ?? null,
    [runsQuery.data],
  );
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
      setOpenSku(null);
      setNote('');
      // Bug fix: previously this said "Issue noted" for EVERY confirm,
      // including the most common "ok" case — confusing. The toast now
      // matches what actually happened.
      //
      // 2026-07-30: during the bulk "mark all OK" loop, stay silent — the
      // loop toasts once when it finishes rather than N times.
      if (bulkRef.current) return;
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
        setOpenSku(null);
        setNote('');
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

  const myItems = (detailQuery.data?.splits ?? []).filter((sp) => sp.storeId === currentStoreId);
  const undecided = myItems.filter((sp) => sp.confirmStatus == null);
  const problems = myItems.filter((sp) => sp.confirmStatus != null && sp.confirmStatus !== 'ok');
  // Hidden only once the confirmation has landed: a button that hides on
  // tap but before the answer invites a second tap.
  const storeConfirmed = myItems.length > 0 && myItems.every((sp) => !!sp.confirmedAt);

  const nameOf = (skuId: string): string => {
    const sku = skuById.get(skuId);
    return sku ? productName(sku) : skuId.slice(0, 8);
  };
  const statusLabel = (status: DecisionStatus): string =>
    i18n.t(`confirm.status.${status}` as Parameters<typeof i18n.t>[0]) as string;

  /**
   * The main action: everything not yet looked at is recorded as fine,
   * then the store is confirmed. One line at a time, because every event
   * lands on the same run and concurrent appends would collide.
   */
  const receiveAll = async () => {
    if (!activeRun || !currentStoreId || storeConfirmed || receiving) return;
    setReceiving(true);
    bulkRef.current = true;
    try {
      for (const it of undecided) {
        writeOptimisticItemConfirm(it.runId, it.skuId, it.storeId, 'ok', null, null);
        await confirmItem.mutateAsync({
          runId: it.runId,
          skuId: it.skuId,
          storeId: it.storeId,
          status: 'ok',
          note: null,
          photoUrl: null,
        });
      }
      await confirmStore.mutateAsync({ runId: activeRun.id, storeId: currentStoreId });
    } catch {
      // Each mutation reports its own failure (or queues itself while
      // offline). Stop here rather than pile requests on a dead network.
    } finally {
      bulkRef.current = false;
      setReceiving(false);
    }
  };

  usePageMainButton(
    problems.length > 0
      ? (i18n.t('receive.confirmWithIssues', { n: problems.length }) as string)
      : (i18n.t('receive.allArrived') as string),
    () => void receiveAll(),
    {
      visible: !!activeRun && myItems.length > 0 && !storeConfirmed,
      active: !receiving && !confirmStore.isPending && !confirmItem.isPending,
    },
  );

  if (!session) return null;

  const open = openSku ? myItems.find((it) => it.skuId === openSku) : undefined;
  const openLine = (skuId: string, current: DecisionStatus | null, currentNote: string | null) => {
    setChoice(current ?? 'ok');
    setNote(currentNote ?? '');
    setOpenSku(skuId);
  };
  const noteOk = choice === 'ok' || note.trim().length > 0;
  const saveVerdict = () => {
    if (!open || !noteOk || confirmItem.isPending) return;
    const text = choice === 'ok' ? null : note.trim();
    writeOptimisticItemConfirm(open.runId, open.skuId, open.storeId, choice, text, null);
    confirmItem.mutate({
      runId: open.runId,
      skuId: open.skuId,
      storeId: open.storeId,
      status: choice,
      note: text,
      photoUrl: null,
    });
  };

  return (
    <div className="flex flex-col gap-xl px-page py-xl">
      <header className="flex items-start justify-between gap-lg">
        <div className="min-w-0">
          <h1 className="text-h1 text-ink">{i18n.t('receive.title')}</h1>
          {activeRun ? (
            <p className="text-body text-secondary">
              {i18n.t('confirm.runOnDate', { date: activeRun.runDate })}
            </p>
          ) : null}
        </div>
        {storeConfirmed ? <StatusChip tone="done">{i18n.t('receive.received')}</StatusChip> : null}
      </header>

      {!currentStoreId ? (
        <EmptyState
          title={
            i18n.t(
              storeCtx.kind === 'none' ? 'auth.noStore.title' : 'storeSwitcher.pickPrompt.title',
            ) as string
          }
          hint={
            i18n.t(
              storeCtx.kind === 'none' ? 'auth.noStore.body' : 'storeSwitcher.pickPrompt.body',
            ) as string
          }
          action={null}
        />
      ) : !activeRun ? (
        <EmptyState
          title={i18n.t('confirm.empty.nothingToConfirm') as string}
          hint={i18n.t('confirm.empty.nothingDesc') as string}
          action={null}
        />
      ) : (
        <DataState query={detailQuery}>
          {() =>
            myItems.length === 0 ? (
              <EmptyState title={i18n.t('confirm.empty.noItems') as string} action={null} />
            ) : (
              <Section
                title={i18n.t('run.label.itemsCount', { n: myItems.length }) as string}
                summary={
                  problems.length > 0 ? (
                    <span className="text-body text-warning-ink">
                      {i18n.t('receive.problems', { n: problems.length })}
                    </span>
                  ) : undefined
                }
              >
                <List>
                  {myItems.map((it) => {
                    const status = it.confirmStatus as DecisionStatus | null;
                    const qty = `${formatQty(it.qty)} ${unitLabel(skuById.get(it.skuId)?.unit)}`;
                    return (
                      <Row
                        key={`${it.runId}:${it.skuId}`}
                        data-testid="receive-row"
                        title={nameOf(it.skuId)}
                        detail={it.confirmNote ? `${qty} · ${it.confirmNote}` : qty}
                        value={
                          status ? (
                            <StatusChip tone={TONE[status]}>{statusLabel(status)}</StatusChip>
                          ) : undefined
                        }
                        onPress={
                          storeConfirmed
                            ? undefined
                            : () => openLine(it.skuId, status, it.confirmNote ?? null)
                        }
                      />
                    );
                  })}
                </List>
              </Section>
            )
          }
        </DataState>
      )}

      {open ? (
        <Sheet
          open
          onOpenChange={(next) => {
            // Not mid-save: the typed note would be lost with nothing to retry.
            if (!next && !confirmItem.isPending) setOpenSku(null);
          }}
          title={nameOf(open.skuId)}
          keepFocus
          actions={
            <Button
              variant="primary"
              data-testid="save-verdict"
              busy={confirmItem.isPending}
              disabled={!noteOk}
              onClick={saveVerdict}
            >
              {i18n.t('confirm.issue.save')}
            </Button>
          }
        >
          <div className="flex flex-col gap-lg">
            <List>
              {STATUSES.map((status) => (
                <Row
                  key={status}
                  picks
                  data-testid={`verdict-${status}`}
                  title={statusLabel(status)}
                  value={
                    status === choice ? (
                      <StatusChip tone={TONE[status]}>{i18n.t('buy.chosen')}</StatusChip>
                    ) : undefined
                  }
                  onPress={() => setChoice(status)}
                />
              ))}
            </List>
            {/* The purchaser has to be able to act on it, so a problem
                needs words. */}
            {choice !== 'ok' ? (
              <Field
                label={i18n.t('receive.note') as string}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={i18n.t('confirm.issue.placeholder') as string}
                maxLength={500}
              />
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
