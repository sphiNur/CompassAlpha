import { Card, DetailRow } from '@compass/ui';
import { useAuthStore } from '../stores/authStore';
import { useDateFormat, useI18n } from '../hooks/useI18n';
import { planName } from '../lib/planName';
import { subscriptionStatusLabel } from '../lib/statusLabels/subscription';

export function SubscriptionSummary() {
  const session = useAuthStore((s) => s.session);
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const sub = session?.subscription;
  if (!sub) return null;

  const limitLabel = (value: number | null) =>
    value == null ? i18n.t('subscription.unlimited') : String(value);
  const endDate = sub.trialEndsAt ?? sub.currentPeriodEnd;

  // Review COREWEB1-23 (2026-11-11): no read-only Banner here. Shell shows
  // one on every page, so the organisation page said it twice (UI-2).
  return (
    <div className="flex flex-col gap-2">
      <Card>
        <div className="flex flex-col gap-2 px-4 py-3">
          <DetailRow
            label={i18n.t('subscription.plan')}
            value={planName(sub.planCode, sub.planName, i18n.locale)}
          />
          <DetailRow
            label={i18n.t('subscription.status')}
            value={subscriptionStatusLabel(i18n, sub.status)}
          />
          {endDate ? (
            <DetailRow
              label={i18n.t(sub.trialEndsAt ? 'subscription.trialEnds' : 'subscription.periodEnds')}
              value={dateFmt.date(endDate)}
            />
          ) : null}
          <DetailRow
            label={i18n.t('subscription.storesUsage')}
            value={`${sub.usage.stores} / ${limitLabel(sub.limits.stores)}`}
          />
          <DetailRow
            label={i18n.t('subscription.membersUsage')}
            value={`${sub.usage.members} / ${limitLabel(sub.limits.members)}`}
          />
        </div>
      </Card>
    </div>
  );
}
