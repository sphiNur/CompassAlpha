import { Banner, Card, DetailRow } from '@compass/ui';
import { useAuthStore } from '../stores/authStore';
import { useDateFormat, useI18n } from '../hooks/useI18n';

export function SubscriptionSummary() {
  const session = useAuthStore((s) => s.session);
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  const sub = session?.subscription;
  if (!sub) return null;

  const limitLabel = (value: number | null) =>
    value == null ? i18n.t('subscription.unlimited') : String(value);
  const endDate = sub.trialEndsAt ?? sub.currentPeriodEnd;

  return (
    <div className="flex flex-col gap-2">
      {!sub.writeAccess ? (
        <Banner tone="warn" title={i18n.t('subscription.readOnlyTitle')}>
          {i18n.t('subscription.readOnlyBody')}
        </Banner>
      ) : null}
      <Card>
        <div className="flex flex-col gap-2 px-4 py-3">
          <DetailRow label={i18n.t('subscription.plan')} value={sub.planName} />
          <DetailRow
            label={i18n.t('subscription.status')}
            value={i18n.t(`subscription.status.${sub.status}` as Parameters<typeof i18n.t>[0])}
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
