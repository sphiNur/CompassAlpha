/**
 * DX-DLV-13 (2026-11-01): why the receiving page has nothing to check.
 * Review CONF-07: moved out of ConfirmPage.
 */
import type { CatalogKey } from '@compass/i18n';
import { EmptyState } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import type { ReceivingWait } from './confirmLogic';

const WAIT_COPY: Record<ReceivingWait, { title: CatalogKey; body: CatalogKey }> = {
  recalled: { title: 'confirm.wait.recalled.title', body: 'confirm.wait.recalled.body' },
  onTheWay: { title: 'confirm.wait.onTheWay.title', body: 'confirm.wait.onTheWay.body' },
  buying: { title: 'confirm.wait.buying.title', body: 'confirm.wait.buying.body' },
  nothing: { title: 'confirm.empty.nothingToConfirm', body: 'confirm.wait.nothing.body' },
};

export function ReceivingWaitState({ wait }: { wait: ReceivingWait }) {
  const i18n = useI18n();
  const copy = WAIT_COPY[wait];
  return (
    <div data-testid={`confirm-wait-${wait}`}>
      <EmptyState title={i18n.t(copy.title)} description={i18n.t(copy.body)} />
    </div>
  );
}
