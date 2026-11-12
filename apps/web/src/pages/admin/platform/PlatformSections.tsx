import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardMeta,
  CardTitle,
  Checkbox,
  DataState,
  Field,
  Input,
  Select,
  Sheet,
  useToast,
} from '@compass/ui';
import { SubscriptionStatusSchema, type SubscriptionStatus } from '@compass/contracts/schemas/auth';
import { trpc, type RouterOutputs } from '../../../lib/trpc';
import { useErrToast } from '../../../hooks/useErrToast';
import { planName } from '../../../lib/planName';
import { subscriptionStatusLabel } from '../../../lib/statusLabels/subscription';
import { useI18n } from '../../../hooks/useI18n';
import { localDateValue } from '../../../lib/calendarDate';

/**
 * A workspace as the platform list returns it. Review ADM1-29 (2026-11-12):
 * read from the router, not written out by hand and cast to.
 */
type PlatformOrg = RouterOutputs['platform']['organizations'][number];

/**
 * The day of `value` in the workspace's calendar, for a date field.
 * Review ADM1-32: it was the UTC day, so an end late in a Tashkent
 * evening showed as the day before. The server reads a day sent back in
 * the same calendar.
 */
function dateValue(value: string | null, timeZone: string): string {
  return value ? localDateValue(new Date(value), timeZone) : '';
}

export function PlatformSection() {
  const i18n = useI18n();
  const orgs = trpc.platform.organizations.useQuery();
  const [target, setTarget] = useState<PlatformOrg | null>(null);

  return (
    <div className="px-4 py-3">
      <DataState
        query={orgs}
        emptyWhen={(rows) => rows.length === 0}
        empty={
          <p className="text-old-body-sm text-[var(--c-fg-muted)]">{i18n.t('platform.empty')}</p>
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((org) => {
              const sub = org.subscription;
              const stores =
                sub.limits.stores == null
                  ? `${sub.usage.stores}`
                  : `${sub.usage.stores}/${sub.limits.stores}`;
              const members =
                sub.limits.members == null
                  ? `${sub.usage.members}`
                  : `${sub.usage.members}/${sub.limits.members}`;
              return (
                <Card as="li" key={org.orgId}>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{org.name}</CardTitle>
                      <CardMeta>
                        {planName(sub.planCode, sub.planName, i18n.locale)} ·{' '}
                        {i18n.t('platform.usage', { stores, members })}
                      </CardMeta>
                    </div>
                    <Badge tone={sub.writeAccess ? 'info' : 'warn'}>
                      {subscriptionStatusLabel(i18n, sub.status)}
                    </Badge>
                  </CardHeader>
                  <div className="flex justify-end px-4 pb-3">
                    <Button size="sm" variant="pearl" onClick={() => setTarget(org)}>
                      {i18n.t('platform.manage')}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>
      <SubscriptionSheet target={target} onClose={() => setTarget(null)} />
    </div>
  );
}

function SubscriptionSheet({
  target,
  onClose,
}: {
  target: PlatformOrg | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const plans = trpc.platform.plans.useQuery(undefined, { enabled: !!target });
  const [planCode, setPlanCode] = useState('');
  const [status, setStatus] = useState<SubscriptionStatus>('active');
  const [trialEndsAt, setTrialEndsAt] = useState('');
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState('');
  const [graceEndsAt, setGraceEndsAt] = useState('');
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!target) return;
    const sub = target.subscription;
    setPlanCode(sub.planCode);
    setStatus(sub.status);
    setTrialEndsAt(dateValue(sub.trialEndsAt, target.timezone));
    setCurrentPeriodEnd(dateValue(sub.currentPeriodEnd, target.timezone));
    setGraceEndsAt(dateValue(sub.graceEndsAt, target.timezone));
    setCancelAtPeriodEnd(sub.cancelAtPeriodEnd);
    setNote(target.note ?? '');
  }, [target]);

  const update = trpc.platform.updateSubscription.useMutation({
    onSuccess: () => {
      void utils.platform.organizations.invalidate();
      toast.success(i18n.t('platform.saved'));
      onClose();
    },
    onError: errToast('common.errors.actionFailed'),
  });

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && !update.isPending && onClose()}
      title={i18n.t('platform.sheet.title', { name: target?.name ?? '' })}
      description={i18n.t('platform.sheet.description')}
      footer={
        <Button
          block
          size="lg"
          loading={update.isPending}
          disabled={!target || !planCode}
          onClick={() => {
            if (!target) return;
            // 2026-10-21 audit CA-39 (A-13): send only what the operator
            // changed. Omitted fields keep their stored value server-side,
            // so an untouched date keeps its exact time and
            // currentPeriodStart / the note are never cleared implicitly.
            const sub = target.subscription;
            const changed = (value: string, initial: string | null) =>
              value === dateValue(initial, target.timezone) ? undefined : value || null;
            update.mutate({
              orgId: target.orgId,
              planCode,
              status,
              trialEndsAt: changed(trialEndsAt, sub.trialEndsAt),
              currentPeriodEnd: changed(currentPeriodEnd, sub.currentPeriodEnd),
              graceEndsAt: changed(graceEndsAt, sub.graceEndsAt),
              cancelAtPeriodEnd,
              note: note.trim() === (target.note ?? '') ? undefined : note.trim() || null,
            });
          }}
        >
          {i18n.t('common.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 py-3">
        <Field label={i18n.t('platform.field.plan')}>
          <Select value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
            {(plans.data ?? []).map((plan) => (
              <option key={plan.code} value={plan.code}>
                {planName(plan.code, plan.name, i18n.locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={i18n.t('platform.field.status')}>
          <Select
            value={status}
            onChange={(e) => {
              const next = SubscriptionStatusSchema.safeParse(e.target.value);
              if (next.success) setStatus(next.data);
            }}
          >
            {SubscriptionStatusSchema.options.map((value) => (
              <option key={value} value={value}>
                {subscriptionStatusLabel(i18n, value)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={i18n.t('platform.field.trialEnds')}>
          <Input type="date" value={trialEndsAt} onChange={(e) => setTrialEndsAt(e.target.value)} />
        </Field>
        <Field
          label={i18n.t('platform.field.periodEnds')}
          hint={i18n.t('platform.field.periodEndsHint')}
        >
          <Input
            type="date"
            value={currentPeriodEnd}
            onChange={(e) => setCurrentPeriodEnd(e.target.value)}
          />
        </Field>
        <Field label={i18n.t('platform.field.graceEnds')}>
          <Input type="date" value={graceEndsAt} onChange={(e) => setGraceEndsAt(e.target.value)} />
        </Field>
        <Checkbox
          checked={cancelAtPeriodEnd}
          onChange={(e) => setCancelAtPeriodEnd(e.target.checked)}
          label={i18n.t('platform.field.cancelAtPeriodEnd')}
        />
        <Field label={i18n.t('platform.field.note')}>
          <Input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} />
        </Field>
      </div>
    </Sheet>
  );
}
