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
import { useAuthStore } from '../../stores/authStore';
import { inRunState } from './inRunState';

export function InRunBanner({
  runId,
  storeId,
  showBody = true,
}: {
  runId: string | null | undefined;
  storeId: string;
  showBody?: boolean;
}) {
  const i18n = useI18n();
  const runQuery = trpc.run.get.useQuery(
    { runId: runId ?? '' },
    { enabled: !!runId, retry: false },
  );
  const setTab = useNavStore((s) => s.setTab);
  const canConfirm = useAuthStore((s) => {
    const perms = s.session?.storePermissions?.[storeId] ?? s.session?.permissions ?? [];
    return perms.includes('delivery.confirm');
  });
  const state = inRunState(runQuery.data, storeId);
  if (state === 'buying') {
    return (
      <Banner tone="info" title={i18n.t('order.banner.inRun.title')}>
        {showBody ? i18n.t('order.banner.inRun.body') : null}
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
