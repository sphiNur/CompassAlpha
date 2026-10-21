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
import { trpc } from '../../../lib/trpc';
import { useErrToast } from '../../../lib/errToast';
import { useI18n } from '../../../hooks/useI18n';

type PlatformOrg = {
  orgId: string;
  name: string;
  slug: string;
  note: string | null;
  subscription: {
    planCode: string;
    planName: string;
    status: string;
    writeAccess: boolean;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    graceEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    limits: { stores: number | null; members: number | null };
    usage: { stores: number; members: number };
  };
};

const STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'canceled'] as const;

function dateValue(value: string | null): string {
  return value ? value.slice(0, 10) : '';
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
            {(rows as PlatformOrg[]).map((org) => {
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
                <Card key={org.orgId}>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{org.name}</CardTitle>
                      <CardMeta>
                        {sub.planName} · {i18n.t('platform.usage', { stores, members })}
                      </CardMeta>
                    </div>
                    <Badge tone={sub.writeAccess ? 'info' : 'warn'}>
                      {i18n.t(`subscription.status.${sub.status}` as Parameters<typeof i18n.t>[0])}
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
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('active');
  const [trialEndsAt, setTrialEndsAt] = useState('');
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState('');
  const [graceEndsAt, setGraceEndsAt] = useState('');
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!target) return;
    const sub = target.subscription;
    setPlanCode(sub.planCode);
    setStatus(sub.status as (typeof STATUSES)[number]);
    setTrialEndsAt(dateValue(sub.trialEndsAt));
    setCurrentPeriodEnd(dateValue(sub.currentPeriodEnd));
    setGraceEndsAt(dateValue(sub.graceEndsAt));
    setCancelAtPeriodEnd(sub.cancelAtPeriodEnd);
    setNote(target.note ?? '');
  }, [target]);

  const update = trpc.platform.updateSubscription.useMutation({
    onSuccess: () => {
      void utils.platform.organizations.invalidate();
      toast.success(i18n.t('platform.saved'));
      onClose();
    },
    onError: errToast('common.error'),
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
              value === dateValue(initial) ? undefined : value || null;
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
                {plan.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={i18n.t('platform.field.status')}>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {i18n.t(`subscription.status.${value}` as Parameters<typeof i18n.t>[0])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={i18n.t('platform.field.trialEnds')}>
          <Input type="date" value={trialEndsAt} onChange={(e) => setTrialEndsAt(e.target.value)} />
        </Field>
        <Field label={i18n.t('platform.field.periodEnds')}>
          <Input
            type="date"
            value={currentPeriodEnd}
            onChange={(e) => setCurrentPeriodEnd(e.target.value)}
          />
          <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('platform.field.periodEndsHint')}
          </p>
        </Field>
        <Field label={i18n.t('platform.field.graceEnds')}>
          <Input type="date" value={graceEndsAt} onChange={(e) => setGraceEndsAt(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-old-body">
          <Checkbox
            checked={cancelAtPeriodEnd}
            onChange={(e) => setCancelAtPeriodEnd(e.target.checked)}
          />
          {i18n.t('platform.field.cancelAtPeriodEnd')}
        </label>
        <Field label={i18n.t('platform.field.note')}>
          <Input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} />
        </Field>
      </div>
    </Sheet>
  );
}
