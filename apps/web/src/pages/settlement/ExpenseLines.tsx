/**
 * The close's operating expense lines: adding, changing and removing
 * them. Review CONF-06: moved out of SettlementPage. CONF-22: whoever may
 * record the close records its expenses (the server's
 * canRecordOperatingExpenses is always true, kept for older clients), so
 * the "manager only" state is gone.
 */
import { Banner, Button, useToast } from '@compass/ui';
import { SETTLEMENT_DETAIL_ITEMS_MAX as MAX_DETAIL_ITEMS } from '@compass/contracts/limits';
import { haptic } from '../../lib/telegram';
import { useI18n } from '../../hooks/useI18n';
import { confirmThen } from '../../lib/confirm';
import { formatMoney } from '../../lib/format';
import { newOperatingExpense, type OperatingExpenseDraft } from './draftModel';
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
  total,
  currency,
  confirmRemoval,
  reveal,
}: {
  lines: Lines;
  /** Changes the lines, from the draft's latest state. */
  update: (change: (lines: Lines) => Lines) => void;
  /** The lines' sum, as money text. */
  total: string;
  currency: string;
  /** Removing a line of a saved close asks first. */
  confirmRemoval: boolean;
  reveal: FieldReveal;
}) {
  const i18n = useI18n();
  const toast = useToast();
  // A total-only row was created before this product recorded individual
  // entries. It has no trustworthy row-level author, so it must remain an
  // immutable historical total instead of being retroactively attributed to
  // the person who happens to open the record today.
  const historical = lines.some((line) => line.isHistorical);
  const editable = !historical;
  const atLimit = lines.length >= MAX_DETAIL_ITEMS;

  const add = () => {
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
    update((current) => [...current, newOperatingExpense()]);
  };

  const change = (id: string, patch: Partial<Omit<OperatingExpenseDraft, 'id'>>) => {
    if (!editable) return;
    update((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const remove = (id: string) => {
    if (!editable) return;
    const drop = () => {
      haptic('light');
      update((current) => current.filter((line) => line.id !== id));
    };
    if (confirmRemoval) confirmThen(i18n.t('settlement.confirm.removeDetail'), drop);
    else drop();
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
          onClick={add}
        >
          {i18n.t('settlement.expenses.add')}
        </Button>
      </DetailListHeader>

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
