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
  FieldGroup,
  Input,
  Sheet,
  useToast,
  rowGroupClass,
} from '@compass/ui';
import { PaymentMethodChips } from '../../../components/PaymentMethodChips';
import { CATALOG_TEXT_MAX } from '@compass/contracts/limits';
import type { PaymentMethod } from '@compass/contracts';
import { trpc } from '../../../lib/trpc';
import { useErrToast } from '../../../hooks/useErrToast';
import { formatMoney, formatQty } from '../../../lib/format';
import { useI18n } from '../../../hooks/useI18n';
import { useCurrency } from '../../../hooks/useCurrency';
import {
  CatalogRowActions,
  CatalogRowHeader,
  CatalogToolbar,
  ReadOnlyHint,
  SortIndexField,
} from './CatalogParts';
import { useUndoToast } from '../../../hooks/useUndoToast';
import { useIsOrgAdmin } from '../../../hooks/useAdminAuthority';
import { useEditorSheet } from '../../../hooks/useDraftChanged';
import { moneyLine } from '../../../lib/money';
import { paymentMethodOrCash } from '../../../lib/paymentMethod';
import { readSortIndex } from './sortIndex';
import { changedFields, hasChanges } from './editPatch';

// ============ Expense Templates (M3.57) ============
//
// Org-level shortcuts for off-catalog expenses (porter / 装卸费, taxi,
// parking). Admin defines them once; the run page uses them to prefill
// a manual expense form so each business day + store records only the
// costs that actually happened.
//
// Mutations require org.admin; reads are open to users.manage so
// store-tier admins can audit the configured list. Archiving hides a
// template from new runs; it can be restored.

/** A template's fields as the editor holds them. */
interface ExpenseTemplateText {
  label: string;
  unitHint: string;
  defaultQty: string;
  /** Null when the saved price is hidden from this reader (no prices.view):
   *  it is not sent, so it stays as saved. */
  defaultUnitPrice: string | null;
  defaultPaymentMethod: PaymentMethod;
}

interface ExpenseTemplateDraft extends ExpenseTemplateText {
  templateId?: string;
  /** As typed (NEW-07); readSortIndex reads it. */
  sortText: string;
  /** What an edit opened with, as sent (ADM2-24); a save sends the rest. */
  opened?: ExpenseTemplateFields;
}

type ExpenseTemplateFields = ReturnType<typeof templateFields>;

/** The fields as the API takes them; a hidden price stays null and is never sent. */
function templateFields(d: ExpenseTemplateText, sortIndex: number) {
  return {
    label: d.label.trim(),
    unitHint: d.unitHint.trim() || null,
    defaultQty: d.defaultQty,
    defaultUnitPrice: d.defaultUnitPrice,
    defaultPaymentMethod: d.defaultPaymentMethod,
    sortIndex,
  };
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
  const archivedToast = useUndoToast();
  const remove = trpc.admin.expenseTemplateDelete.useMutation({
    onSuccess: (_data, vars) => {
      void utils.admin.expenseTemplateList.invalidate();
      archivedToast(i18n.t('admin.toast.expenseTemplateArchived'), () =>
        update.mutate({ templateId: vars.templateId, isArchived: false }),
      );
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const currency = useCurrency();

  const editor = useEditorSheet(
    draft,
    setDraft,
    (d) => d.templateId ?? 'new',
    create.isPending || update.isPending,
  );
  const sortIndex = draft ? readSortIndex(draft.sortText) : null;

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
            sortText: '0',
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
                            transfer-only rows at a glance. Without
                            prices.view, the quantity alone. ADM2-38:
                            formatMoney places the currency, as for every
                            other amount. */}
                        {formatQty(tpl.defaultQty)}
                        {tpl.defaultUnitPrice !== null ? (
                          <>
                            {' × '}
                            {formatMoney(tpl.defaultUnitPrice, currency)}
                            {' = '}
                            <span className="font-semibold text-[var(--c-fg)]">
                              {formatMoney(lineTotal, currency)}
                            </span>
                          </>
                        ) : null}
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
                      onEdit={() => {
                        const text = {
                          label: tpl.label,
                          unitHint: tpl.unitHint ?? '',
                          defaultQty: tpl.defaultQty,
                          defaultUnitPrice: tpl.defaultUnitPrice,
                          defaultPaymentMethod: paymentMethodOrCash(tpl.defaultPaymentMethod),
                        };
                        setDraft({
                          templateId: tpl.id,
                          ...text,
                          sortText: String(tpl.sortIndex),
                          opened: templateFields(text, tpl.sortIndex),
                        });
                      }}
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
              (draft.defaultUnitPrice !== null &&
                (!draft.defaultUnitPrice || Number(draft.defaultUnitPrice) <= 0)) ||
              sortIndex === null
            }
            onClick={() => {
              if (!draft || sortIndex === null) return;
              const fields = templateFields(draft, sortIndex);
              if (!draft.templateId) {
                const { defaultUnitPrice, ...rest } = fields;
                // A new template's price is typed, never hidden.
                if (defaultUnitPrice !== null) create.mutate({ ...rest, defaultUnitPrice });
                return;
              }
              // ADM2-24: only what this edit changed. A hidden price is null
              // on both sides, so it is never among the changes.
              const changes = draft.opened ? changedFields(fields, draft.opened) : fields;
              if (!hasChanges(changes)) {
                setDraft(null);
                return;
              }
              const { defaultUnitPrice, ...rest } = changes;
              update.mutate({
                templateId: draft.templateId,
                ...rest,
                ...(defaultUnitPrice ? { defaultUnitPrice } : {}),
              });
            }}
          >
            {i18n.t('common.save')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label={i18n.t('admin.field.label')} required>
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
              <Field label={i18n.t('admin.field.defaultQty')} required>
                <Input
                  // CAT-10: read "1,5" / "20 000" like every number field.
                  type="number"
                  value={draft.defaultQty}
                  onChange={(e) => setDraft({ ...draft, defaultQty: e.target.value })}
                  inputMode="decimal"
                  placeholder="1"
                />
              </Field>
              {draft.defaultUnitPrice !== null ? (
                <Field label={i18n.t('admin.field.defaultUnitPrice')} required>
                  <Input
                    // CAT-10: read "1,5" / "20 000" like every number field.
                    type="number"
                    value={draft.defaultUnitPrice}
                    onChange={(e) => setDraft({ ...draft, defaultUnitPrice: e.target.value })}
                    inputMode="decimal"
                    placeholder="50000"
                  />
                </Field>
              ) : null}
            </div>
            {/* A group, not a Field: inside Field's <label> a tap on the
                title chose "cash" (UI-01). */}
            <FieldGroup label={i18n.t('admin.field.defaultPaymentMethod')}>
              {/* DX-VIS-7 (2026-11-01): the shared cash / transfer control
                  (Segmented underneath), not a third hand-rolled copy. */}
              <PaymentMethodChips
                value={draft.defaultPaymentMethod}
                onChange={(m) => setDraft({ ...draft, defaultPaymentMethod: m })}
              />
            </FieldGroup>
            <SortIndexField
              text={draft.sortText}
              onText={(sortText) => setDraft({ ...draft, sortText })}
            />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
