/**
 * Admin → Catalog → Expense templates. Review ADM2-11 (2026-11-11): one
 * file per catalog section.
 */
import { useState } from 'react';
import {
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  Sheet,
  useToast,
  rowGroupClass,
} from '@compass/ui';
import { PaymentMethodChips } from '../../../components/PaymentMethodChips';
import { CATALOG_TEXT_MAX } from '@compass/contracts/limits';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { formatMoney, formatQty } from '../../../lib/format';
import { useI18n } from '../../../hooks/useI18n';
import {
  CatalogRowActions,
  CatalogRowHeader,
  CatalogToolbar,
  ReadOnlyHint,
  useIsOrgAdmin,
} from './CatalogParts';
import { useEditorSheet } from '../../../hooks/useDraftChanged';
import { moneyLine } from '../../../lib/money';

// ============ Expense Templates (M3.57) ============
//
// Org-level shortcuts for off-catalog expenses (porter / 装卸费, taxi,
// parking). Admin defines them once; the run page uses them to prefill
// a manual expense form so each business day + store records only the
// costs that actually happened.
//
// CRUD only (no audit timeline, no soft-delete UI niceties — kept
// simple for v1). Mutations require org.admin; reads are open to
// users.manage so store-tier admins can audit the configured list.

interface ExpenseTemplateDraft {
  templateId?: string;
  label: string;
  unitHint: string;
  defaultQty: string;
  defaultUnitPrice: string;
  defaultPaymentMethod: 'cash' | 'transfer';
  sortIndex: number;
  isArchived: boolean;
}

export function ExpenseTemplatesSection() {
  const i18n = useI18n();
  const [includeArchived, setIncludeArchived] = useState(false);
  const templatesQuery = trpc.admin.expenseTemplateList.useQuery({
    includeArchived,
  });
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const canWrite = useIsOrgAdmin();
  const [draft, setDraft] = useState<ExpenseTemplateDraft | null>(null);

  const create = trpc.admin.expenseTemplateCreate.useMutation({
    onSuccess: () => {
      void utils.admin.expenseTemplateList.invalidate();
      toast.success(i18n.t('admin.toast.expenseTemplateCreated'));
      setDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const update = trpc.admin.expenseTemplateUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.expenseTemplateList.invalidate();
      toast.success(i18n.t('admin.toast.expenseTemplateUpdated'));
      setDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const remove = trpc.admin.expenseTemplateDelete.useMutation({
    onSuccess: () => {
      void utils.admin.expenseTemplateList.invalidate();
      toast.info(i18n.t('admin.toast.expenseTemplateArchived'));
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';

  const editor = useEditorSheet(
    draft,
    setDraft,
    (d) => d.templateId ?? 'new',
    create.isPending || update.isPending,
  );

  return (
    <div className="px-4 py-3">
      {canWrite ? null : <ReadOnlyHint />}
      <CatalogToolbar
        newLabel={canWrite ? i18n.t('admin.action.newExpenseTemplate') : undefined}
        onNew={() =>
          setDraft({
            label: '',
            unitHint: '',
            defaultQty: '1',
            defaultUnitPrice: '',
            defaultPaymentMethod: 'cash',
            sortIndex: 0,
            isArchived: false,
          })
        }
        showArchived={includeArchived}
        onShowArchivedChange={setIncludeArchived}
      />
      <p className="mb-3 text-old-label text-[var(--c-fg-muted)]">
        {i18n.t('admin.expenseTemplates.intro')}
      </p>
      <DataState
        query={templatesQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('admin.expenseTemplates.empty.title')}
            description={i18n.t('admin.expenseTemplates.empty.body')}
          />
        }
      >
        {(rows) => (
          <ul className={rowGroupClass} role="list">
            {rows.map((tpl) => {
              const lineTotal = moneyLine(tpl.defaultQty, tpl.defaultUnitPrice) ?? 0;
              return (
                <li key={tpl.id}>
                  <CatalogRowHeader
                    title={tpl.label}
                    meta={
                      <>
                        {tpl.unitHint ? `${tpl.unitHint} · ` : ''}
                        {/* Default quantity × unit price = the line, and
                            how it is paid, so the manager can spot the
                            transfer-only rows at a glance. */}
                        {formatQty(tpl.defaultQty)} × {formatMoney(tpl.defaultUnitPrice)} {currency}
                        {' = '}
                        <span className="font-semibold text-[var(--c-fg)]">
                          {formatMoney(lineTotal)} {currency}
                        </span>
                        {' · '}
                        {tpl.defaultPaymentMethod === 'transfer'
                          ? i18n.t('run.label.paymentTransfer')
                          : i18n.t('run.label.paymentCash')}
                      </>
                    }
                    archived={tpl.isArchived}
                  />
                  {canWrite ? (
                    <CatalogRowActions
                      archived={tpl.isArchived}
                      onEdit={() =>
                        setDraft({
                          templateId: tpl.id,
                          label: tpl.label,
                          unitHint: tpl.unitHint ?? '',
                          defaultQty: tpl.defaultQty,
                          defaultUnitPrice: tpl.defaultUnitPrice,
                          defaultPaymentMethod: tpl.defaultPaymentMethod as 'cash' | 'transfer',
                          sortIndex: tpl.sortIndex,
                          isArchived: tpl.isArchived,
                        })
                      }
                      confirmArchive={i18n.t('admin.confirm.archiveExpenseTemplate', {
                        label: tpl.label,
                      })}
                      onArchive={() => remove.mutate({ templateId: tpl.id })}
                      onUnarchive={() => update.mutate({ templateId: tpl.id, isArchived: false })}
                      unarchiving={update.isPending && update.variables?.templateId === tpl.id}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      <Sheet
        {...editor}
        title={
          draft?.templateId
            ? i18n.t('admin.sheet.editExpenseTemplate')
            : i18n.t('admin.sheet.newExpenseTemplate')
        }
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={
              !draft?.label.trim() ||
              !draft.defaultQty ||
              Number(draft.defaultQty) <= 0 ||
              !draft.defaultUnitPrice ||
              Number(draft.defaultUnitPrice) <= 0
            }
            onClick={() => {
              if (!draft) return;
              if (draft.templateId) {
                update.mutate({
                  templateId: draft.templateId,
                  label: draft.label.trim(),
                  unitHint: draft.unitHint.trim() || null,
                  defaultQty: draft.defaultQty,
                  defaultUnitPrice: draft.defaultUnitPrice,
                  defaultPaymentMethod: draft.defaultPaymentMethod,
                  sortIndex: draft.sortIndex,
                  isArchived: draft.isArchived,
                });
              } else {
                create.mutate({
                  label: draft.label.trim(),
                  unitHint: draft.unitHint.trim() || null,
                  defaultQty: draft.defaultQty,
                  defaultUnitPrice: draft.defaultUnitPrice,
                  defaultPaymentMethod: draft.defaultPaymentMethod,
                  sortIndex: draft.sortIndex,
                });
              }
            }}
          >
            {i18n.t('common.save')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label={`${i18n.t('admin.field.label')} *`}>
              <Input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                maxLength={CATALOG_TEXT_MAX.name}
                placeholder={i18n.t('admin.expenseTemplates.labelPlaceholder')}
                autoFocus
              />
            </Field>
            <Field label={i18n.t('admin.field.unitHint')}>
              <Input
                value={draft.unitHint}
                onChange={(e) => setDraft({ ...draft, unitHint: e.target.value })}
                maxLength={CATALOG_TEXT_MAX.unitHint}
                placeholder={i18n.t('admin.expenseTemplates.unitHintPlaceholder')}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`${i18n.t('admin.field.defaultQty')} *`}>
                <Input
                  // CAT-10: read "1,5" / "20 000" like every number field.
                  type="number"
                  value={draft.defaultQty}
                  onChange={(e) => setDraft({ ...draft, defaultQty: e.target.value })}
                  inputMode="decimal"
                  placeholder="1"
                />
              </Field>
              <Field label={`${i18n.t('admin.field.defaultUnitPrice')} *`}>
                <Input
                  // CAT-10: read "1,5" / "20 000" like every number field.
                  type="number"
                  value={draft.defaultUnitPrice}
                  onChange={(e) => setDraft({ ...draft, defaultUnitPrice: e.target.value })}
                  inputMode="decimal"
                  placeholder="50000"
                />
              </Field>
            </div>
            <Field label={i18n.t('admin.field.defaultPaymentMethod')}>
              {/* DX-VIS-7 (2026-11-01): the shared cash / transfer control
                  (Segmented underneath), not a third hand-rolled copy. */}
              <PaymentMethodChips
                value={draft.defaultPaymentMethod === 'transfer' ? 'transfer' : 'cash'}
                onChange={(m) => setDraft({ ...draft, defaultPaymentMethod: m })}
              />
            </Field>
            <Field label={i18n.t('admin.field.sortIndex')}>
              <Input
                value={String(draft.sortIndex)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    sortIndex: Number(e.target.value) || 0,
                  })
                }
                inputMode="numeric"
              />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
