import { useState } from 'react';
import { useToast } from '@compass/ui';
import { Button, ChoiceGroup, cn, Field, PaymentChip, Sheet } from '@compass/ui/kit';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useErrToast } from '../../lib/errToast';
import { confirmThen } from '../../lib/confirm';
import { useI18n } from '../../hooks/useI18n';
import { currencyOf, formatMoney, formatQty } from '../../lib/format';
import { ChevronIcon, ClockIcon, PlusIcon } from '../icons';

interface Draft {
  templateId?: string;
  archived: boolean;
  label: string;
  unitHint: string;
  defaultQty: string;
  defaultUnitPrice: string;
  defaultPaymentMethod: 'cash' | 'transfer';
  sortIndex: number;
}

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70';

/**
 * Spending that comes up again and again and is not a product: a porter,
 * a taxi, parking. Each one saved here is one tap when recording it,
 * with its usual amount and how it is usually paid.
 */
export function SpendingTemplates() {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const currency = currencyOf(useAuthStore((s) => s.session));
  const [archivedToo, setArchivedToo] = useState(false);
  const templates = trpc.admin.expenseTemplateList.useQuery({ includeArchived: archivedToo });
  const [draft, setDraft] = useState<Draft | null>(null);

  const done = (message: string) => () => {
    void utils.admin.expenseTemplateList.invalidate();
    void utils.run.expenseTemplates.invalidate();
    toast.success(message);
    setDraft(null);
  };
  const create = trpc.admin.expenseTemplateCreate.useMutation({
    onSuccess: done(i18n.t('admin.toast.expenseTemplateCreated') as string),
    onError: errToast('common.error'),
  });
  const update = trpc.admin.expenseTemplateUpdate.useMutation({
    onSuccess: done(i18n.t('admin.toast.expenseTemplateUpdated') as string),
    onError: errToast('common.error'),
  });
  const archive = trpc.admin.expenseTemplateDelete.useMutation({
    onSuccess: done(i18n.t('admin.toast.expenseTemplateArchived') as string),
    onError: errToast('common.error'),
  });
  const busy = create.isPending || update.isPending || archive.isPending;

  const method = (m: string) =>
    i18n.t(m === 'transfer' ? 'run.label.paymentTransfer' : 'run.label.paymentCash') as string;
  const ok =
    !!draft &&
    draft.label.trim().length > 0 &&
    Number(draft.defaultQty) > 0 &&
    Number(draft.defaultUnitPrice) > 0;
  const save = () => {
    if (!draft || !ok) return;
    const body = {
      label: draft.label.trim(),
      unitHint: draft.unitHint.trim() || null,
      defaultQty: draft.defaultQty,
      defaultUnitPrice: draft.defaultUnitPrice,
      defaultPaymentMethod: draft.defaultPaymentMethod,
      sortIndex: draft.sortIndex,
    };
    if (draft.templateId) {
      update.mutate({ templateId: draft.templateId, ...body, isArchived: draft.archived });
    } else {
      create.mutate(body);
    }
  };

  return (
    <div className="flex flex-col gap-xl px-page">
      <button
        type="button"
        data-testid="template-new"
        onClick={() =>
          setDraft({
            archived: false,
            label: '',
            unitHint: '',
            defaultQty: '1',
            defaultUnitPrice: '',
            defaultPaymentMethod: 'cash',
            sortIndex: 100,
          })
        }
        className="flex items-center gap-lg rounded-lg border border-dashed border-line p-xl text-start outline-none active:opacity-60"
      >
        <span
          aria-hidden
          className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
        >
          <PlusIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-label text-ink">
            {i18n.t('admin.sheet.newExpenseTemplate')}
          </span>
          <span className="block text-small text-secondary">
            {i18n.t('templates.hint')}
          </span>
        </span>
        <span className="shrink-0 text-forest">
          <ChevronIcon />
        </span>
      </button>

      <button
        type="button"
        aria-pressed={archivedToo}
        data-testid="template-archived"
        onClick={() => setArchivedToo(!archivedToo)}
        className={cn(
          CAPSULE,
          'self-start',
          archivedToo ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink',
        )}
      >
        {i18n.t('admin.label.showArchived')}
      </button>

      {templates.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : templates.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : templates.data.length === 0 ? (
        <div className="flex items-center gap-lg">
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
          >
            <ClockIcon />
          </span>
          <span className="text-label text-secondary">
            {i18n.t('admin.expenseTemplates.empty.title')}
          </span>
        </div>
      ) : (
        <ul className="flex flex-col">
          {templates.data.map((tpl) => (
            <li key={tpl.id}>
              <button
                type="button"
                data-testid="template-row"
                onClick={() =>
                  setDraft({
                    templateId: tpl.id,
                    archived: tpl.isArchived,
                    label: tpl.label,
                    unitHint: tpl.unitHint ?? '',
                    defaultQty: String(Number(tpl.defaultQty)),
                    defaultUnitPrice: String(Number(tpl.defaultUnitPrice)),
                    defaultPaymentMethod:
                      tpl.defaultPaymentMethod === 'transfer' ? 'transfer' : 'cash',
                    sortIndex: tpl.sortIndex,
                  })
                }
                className="flex min-h-row w-full items-center gap-lg py-sm text-start outline-none active:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block text-label',
                      tpl.isArchived ? 'text-secondary line-through' : 'text-ink',
                    )}
                  >
                    {tpl.label}
                  </span>
                  <span className="block text-small text-secondary" dir="ltr">
                    {formatQty(tpl.defaultQty)} {tpl.unitHint ?? ''} ×{' '}
                    {formatMoney(tpl.defaultUnitPrice)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-xs">
                  <span className="text-money tabular-nums text-ink" dir="ltr">
                    {formatMoney(Number(tpl.defaultQty) * Number(tpl.defaultUnitPrice))}{' '}
                    <span className="text-caption text-secondary">{currency}</span>
                  </span>
                  <PaymentChip
                    method={tpl.defaultPaymentMethod === 'transfer' ? 'transfer' : 'cash'}
                    label={method(tpl.defaultPaymentMethod)}
                  />
                </span>
                <span className="shrink-0 text-forest">
                  <ChevronIcon />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={!!draft}
        onOpenChange={(next) => !next && !busy && setDraft(null)}
        title={
          i18n.t(
            draft?.templateId
              ? 'admin.sheet.editExpenseTemplate'
              : 'admin.sheet.newExpenseTemplate',
          ) as string
        }
        actions={
          draft ? (
            <>
              <Button
                variant="primary"
                data-testid="template-save"
                busy={create.isPending || update.isPending}
                disabled={!ok || archive.isPending}
                onClick={save}
              >
                {draft.templateId ? i18n.t('common.save') : i18n.t('common.create')}
              </Button>
              {draft.templateId && !draft.archived ? (
                <Button
                  variant="ghost"
                  data-testid="template-archive"
                  disabled={busy}
                  onClick={() =>
                    confirmThen(
                      i18n.t('admin.confirm.archiveExpenseTemplate', {
                        label: draft.label,
                      }) as string,
                      () => archive.mutate({ templateId: draft.templateId! }),
                    )
                  }
                >
                  <span className="text-danger">{i18n.t('common.archive')}</span>
                </Button>
              ) : null}
              {draft.templateId && draft.archived ? (
                <Button
                  variant="secondary"
                  data-testid="template-unarchive"
                  disabled={busy}
                  onClick={() =>
                    update.mutate({ templateId: draft.templateId!, isArchived: false })
                  }
                >
                  {i18n.t('common.unarchive')}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {draft ? (
          <div className="flex flex-col gap-md">
            <Field
              label={i18n.t('admin.field.label') as string}
              value={draft.label}
              maxLength={200}
              placeholder={i18n.t('admin.expenseTemplates.labelPlaceholder') as string}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <Field
              numeric
              label={i18n.t('admin.field.defaultQty') as string}
              value={draft.defaultQty}
              onChange={(e) => setDraft({ ...draft, defaultQty: e.target.value.replace(',', '.') })}
            />
            <Field
              label={i18n.t('admin.field.unitHint') as string}
              value={draft.unitHint}
              maxLength={32}
              placeholder={i18n.t('admin.expenseTemplates.unitHintPlaceholder') as string}
              onChange={(e) => setDraft({ ...draft, unitHint: e.target.value })}
            />
            <Field
              numeric
              label={i18n.t('admin.field.defaultUnitPrice') as string}
              value={draft.defaultUnitPrice}
              suffix={currency}
              onChange={(e) =>
                setDraft({ ...draft, defaultUnitPrice: e.target.value.replace(',', '.') })
              }
            />
            <ChoiceGroup<'cash' | 'transfer'>
              label={i18n.t('admin.field.defaultPaymentMethod') as string}
              value={draft.defaultPaymentMethod}
              onChange={(defaultPaymentMethod) => setDraft({ ...draft, defaultPaymentMethod })}
              options={[
                { value: 'cash', label: method('cash') },
                { value: 'transfer', label: method('transfer') },
              ]}
            />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
