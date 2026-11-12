/**
 * DX-DLV-13 (2026-11-01): the order page's banner for an order on a
 * purchase run follows the run: being bought, on the way, recalled,
 * delivered and waiting to be checked (with a way to the 验收 tab), or
 * checked. Without a run to read it stays 「采购中 · 正在购买」.
 */
import { Banner, Button } from '@compass/ui';
import { trpc } from '../../lib/trpc';
import { useI18n } from '../../hooks/useI18n';
import { requestTabChange, useNavStore } from '../../stores/navStore';
import { useStorePermission } from '../../hooks/useStorePermission';
import { inRunState } from './inRunState';

export function InRunBanner({
  runId,
  storeId,
}: {
  runId: string | null | undefined;
  storeId: string;
}) {
  const i18n = useI18n();
  // Review ORD-26 (2026-11): only this store's progress (run.storeProgress,
  // with run.get's checks); it read the whole of run.get for a status.
  const progress = trpc.run.storeProgress.useQuery(
    { runId: runId ?? '', storeId },
    { enabled: !!runId, retry: false },
  );
  const setTab = useNavStore((s) => s.setTab);
  // Review ORD-28 (2026-11): the shared per-store check (hasStorePermission).
  const canConfirm = useStorePermission('delivery.confirm', storeId);
  const state = inRunState(progress.data, storeId);
  if (state === 'buying') {
    return (
      <Banner tone="info" title={i18n.t('order.banner.inRun.title')}>
        {i18n.t('order.banner.inRun.body')}
      </Banner>
    );
  }
  if (state === 'toCheck') {
    return (
      <Banner
        tone="success"
        title={i18n.t('order.banner.delivered.title')}
        action={
          canConfirm ? (
            <Button
              variant="pearl"
              size="sm"
              onClick={() => {
                void requestTabChange('confirm').then((ok) => {
                  if (ok) setTab('confirm');
                });
              }}
            >
              {i18n.t('order.banner.delivered.action')}
            </Button>
          ) : undefined
        }
      />
    );
  }
  const title =
    state === 'onTheWay'
      ? 'order.banner.onTheWay.title'
      : state === 'recalled'
        ? 'order.banner.recalled.title'
        : 'order.banner.checked.title';
  return <Banner tone={state === 'recalled' ? 'warn' : 'info'} title={i18n.t(title)} />;
}
