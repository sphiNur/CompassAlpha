/**
 * One of the close's top amounts, with the reason it is not valid under
 * it (A11Y-2, DX-CLS-4, CONF-21). Review CONF-06: moved out of
 * SettlementPage.
 */
import { Field, Input } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { isMoney } from './draftModel';
import { MONEY_PROBLEM_MESSAGE, moneyProblem } from './moneyProblem';

export function AmountField({
  label,
  value,
  signed = false,
  revealError,
  onLeave,
  onChange,
}: {
  label: string;
  value: string;
  signed?: boolean;
  /**
   * Review CONF-21: whether a problem may show yet. Like the expense and
   * wage lines (DX-VIS-15), once the field was left or a save was tried;
   * it used to show from the first keystroke.
   */
  revealError: boolean;
  onLeave: () => void;
  onChange: (value: string) => void;
}) {
  const i18n = useI18n();
  // DX-CLS-4 (2026-11-01): one sentence per reason; negative, empty and
  // too long all read "enter a number, at most two decimals".
  const problem = isMoney(value, signed) ? null : (moneyProblem(value, { signed }) ?? 'notNumber');
  const shown = problem !== null && revealError;
  // A11Y-2 (2026-10-31): the reason sits under the field it is about and
  // is tied to it (the Field does that, UI-02). It used to be one unnamed
  // banner ~1,100 px further down, and the field only turned its edge red
  // (hidden under the focus ring while typing).
  return (
    <Field
      label={label}
      error={
        problem !== null && shown ? i18n.t(MONEY_PROBLEM_MESSAGE[problem], { field: label }) : null
      }
    >
      <Input
        type="number"
        value={value}
        placeholder="0"
        // The field's error covers "not a number" too; one message, not two.
        formatError="none"
        onChange={(event) => onChange(event.target.value)}
        onBlur={onLeave}
      />
    </Field>
  );
}
