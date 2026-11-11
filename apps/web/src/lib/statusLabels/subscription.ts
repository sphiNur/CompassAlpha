import type { SubscriptionStatus } from '@compass/contracts/schemas/auth';
import type { CatalogKey } from '@compass/i18n';
import { labelIn, type Translate } from './table';

const SUBSCRIPTION_STATUS: Record<SubscriptionStatus, CatalogKey> = {
  trialing: 'subscription.status.trialing',
  active: 'subscription.status.active',
  past_due: 'subscription.status.past_due',
  suspended: 'subscription.status.suspended',
  canceled: 'subscription.status.canceled',
};

export function subscriptionStatusLabel(
  i18n: Translate,
  status: string | null | undefined,
): string {
  return labelIn(i18n, SUBSCRIPTION_STATUS, status);
}
