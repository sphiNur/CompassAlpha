import type { OrderStatus } from '@compass/contracts/schemas/order';
import type { CatalogKey } from '@compass/i18n';
import { labelIn, type Translate } from './table';

/**
 * ORD-18 (2026-10-30): a rejected order reads "Rejected" alone;
 * `order.status.rejected` carries the reason, for the order's banner.
 */
const ORDER_STATUS: Record<OrderStatus, CatalogKey> = {
  draft: 'order.status.draft',
  submitted: 'order.status.submitted',
  approved: 'order.status.approved',
  rejected: 'order.status.rejectedTitle',
  in_run: 'order.status.in_run',
  archived: 'order.status.archived',
};

export function orderStatusLabel(i18n: Translate, status: string | null | undefined): string {
  return labelIn(i18n, ORDER_STATUS, status);
}
