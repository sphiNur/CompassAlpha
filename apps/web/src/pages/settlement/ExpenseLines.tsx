/**
 * The close's operating expense lines: adding, changing and removing
 * them. Review CONF-06: moved out of SettlementPage. CONF-22: whoever may
 * record the close records its expenses (the server's
 * canRecordOperatingExpenses is always true, kept for older clients), so
 * the "manager only" state is gone. S5 (2026-11-13): the organisation's
 * expense templates add a filled-in line.
 */
import { Banner, Button, FieldGroup, useToast } from '@compass/ui';
import { SETTLEMENT_DETAIL_ITEMS_MAX as MAX_DETAIL_ITEMS } from '@compass/contracts/limits';
import { trpc } from '../../lib/trpc';
import { haptic } from '../../lib/telegram';
import { useI18n } from '../../hooks/useI18n';
import { formatMoney } from '../../lib/format';
import {
  expenseFromTemplate,
  newOperatingExpense,
  type ExpenseTemplate,
  type OperatingExpenseDraft,
} from './draftModel';
import {
  DetailLineFrame,
  DetailLineList,
  DetailListEmpty,
  DetailListHeader,
  LineAmountField,
  LineReasonField,
  lineProblems,
  type FieldReveal,
} from './DetailLine';

type Lines = OperatingExpenseDraft[];

export function ExpenseLines({
  lines,
  update,
  storeId,
  total,
  currency,
  reveal,
}: {
  lines: Lines;
  /** Changes the lines, from the draft's latest state. */
  update: (change: (lines: Lines) => Lines) => void;
  /** The close's store, whose templates (and their prices) are offered. */
  storeId: string;
  /** The lines' sum, as money text. */
  total: string;
  currency: string;
  reveal: FieldReveal;
}) {
  const i18n = useI18n();
  const toast = useToast();
  // A default price comes back only with prices.view in this store; the
  // line's amount is typed otherwise.
  const templatesQuery = trpc.settlement.expenseTemplates.useQuery({ storeId });
  const templates = templatesQuery.data ?? [];
  // A total-only row was created before this product recorded individual
  // entries. It has no trustworthy row-level author, so it must remain an
  // immutable historical total instead of being retroactively attributed to
  // the person who happens to open the record today.
  const historical = lines.some((line) => line.isHistorical);
  const editable = !historical;
  const atLimit = lines.length >= MAX_DETAIL_ITEMS;

  const add = (line: OperatingExpenseDraft = newOperatingExpense()) => {
    if (!editable) {
      haptic('warning');
      toast.error(i18n.t('settlement.details.historicalReadOnly'));
      return;
    }
    if (atLimit) {
      haptic('warning');
      toast.error(i18n.t('settlement.errors.detailLimit', { count: MAX_DETAIL_ITEMS }));
      return;
    }
    haptic('light');
    update((current) => [...current, line]);
  };
  const addFromTemplate = (template: ExpenseTemplate) => add(expenseFromTemplate(template));

  const change = (id: string, patch: Partial<Omit<OperatingExpenseDraft, 'id'>>) => {
    if (!editable) return;
    update((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  // S3 (2026-11-13): no confirmation. The removal is an unsaved edit:
  // leaving without saving asks, and a saved close keeps its versions.
  const remove = (id: string) => {
    if (!editable) return;
    haptic('light');
    update((current) => current.filter((line) => line.id !== id));
  };

  return (
    <div className="flex flex-col gap-3">
      <DetailListHeader
        title={i18n.t('settlement.expenses.title')}
        summary={i18n.t('settlement.expenses.total', { money: formatMoney(total, currency) })}
      >
        <Button
          className="shrink-0"
          size="sm"
          variant="secondary"
          disabled={!editable || atLimit}
          onClick={() => add()}
        >
          {i18n.t('settlement.expenses.add')}
        </Button>
      </DetailListHeader>

      {editable && templates.length > 0 ? (
        <FieldGroup label={i18n.t('settlement.expenses.templates')}>
          {/* As the run sheet's shortcuts (RUNWEB2-23): kit buttons with a
              44 px tap, 12 px between wrapped rows. */}
          <div className="flex flex-wrap gap-x-1.5 gap-y-3">
            {templates.map((template) => (
              <Button
                key={template.id}
                size="sm"
                variant="secondary"
                disabled={atLimit}
                onClick={() => addFromTemplate(template)}
              >
                {template.label}
              </Button>
            ))}
          </div>
        </FieldGroup>
      ) : null}

      {historical ? (
        <Banner tone="info" title={i18n.t('settlement.details.historicalReadOnly')}>
          {i18n.t('settlement.details.historicalReadOnlyBody')}
        </Banner>
      ) : null}

      {lines.length === 0 ? (
        <DetailListEmpty>{i18n.t('settlement.expenses.empty')}</DetailListEmpty>
      ) : (
        <DetailLineList>
          {lines.map((expense, index) => {
            const title = i18n.t('settlement.expenses.itemNumber', { n: index + 1 });
            const problems = lineProblems(expense, reveal);
            return (
              <DetailLineFrame
                key={expense.id}
                title={title}
                removeLabel={i18n.t('settlement.expenses.remove')}
                onRemove={editable ? () => remove(expense.id) : undefined}
              >
                <LineAmountField
                  label={i18n.t('settlement.expenses.amount')}
                  name={`${title} · ${i18n.t('settlement.expenses.amount')}`}
                  value={expense.amount}
                  readOnly={!editable}
                  problem={problems.amount}
                  onLeave={() => reveal.leave(`${expense.id}:amount`)}
                  onChange={(amount) => change(expense.id, { amount, isHistorical: false })}
                />
                <LineReasonField
                  label={i18n.t('settlement.expenses.reason')}
                  name={`${title} · ${i18n.t('settlement.expenses.reason')}`}
                  historicalText={i18n.t('settlement.expenses.historicalReason')}
                  isHistorical={expense.isHistorical}
                  value={expense.reason}
                  readOnly={!editable}
                  missing={problems.reasonMissing}
                  onLeave={() => reveal.leave(`${expense.id}:reason`)}
                  onChange={(reason) => change(expense.id, { reason, isHistorical: false })}
                />
              </DetailLineFrame>
            );
          })}
        </DetailLineList>
      )}
    </div>
  );
}
