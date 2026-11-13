/**
 * The parts the expense list and the wage list share: the list's header
 * and empty state, the numbered line with its remove button, and the
 * line's amount and reason fields. Review CONF-06: the two lists wrote
 * all of these twice. CONF-11: the lines are rows divided by hairlines
 * inside the card (UI-6 / UI-13); each was a grey card of its own.
 */
import type { ReactNode } from 'react';
import { Button, EmptyState, Field, Input, Textarea, rowListClass } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { ITEM_MONEY_PROBLEM_MESSAGE, moneyProblem, type MoneyProblem } from './moneyProblem';

/**
 * DX-VIS-15 (2026-11-01): a line's field is marked only after it was left
 * or a save was tried, not as the line appears.
 */
export interface FieldReveal {
  /** Whether an `invalid` field named `key` shows its problem yet. */
  shows: (invalid: boolean, key: string) => boolean;
  /** The field named `key` was left. */
  leave: (key: string) => void;
}

/**
 * What a line's amount and reason show as wrong right now. S4
 * (2026-11-13): a wage line's reason is optional (`reasonRequired`
 * false), so it is never missing.
 */
export function lineProblems(
  line: { id: string; amount: string; reason: string; isHistorical: boolean },
  reveal: FieldReveal,
  { reasonRequired = true }: { reasonRequired?: boolean } = {},
): { amount: MoneyProblem | null; reasonMissing: boolean } {
  const amount = line.isHistorical ? null : moneyProblem(line.amount, { positive: true });
  return {
    amount: reveal.shows(amount !== null, `${line.id}:amount`) ? amount : null,
    reasonMissing: reveal.shows(
      reasonRequired && !line.isHistorical && line.reason.trim().length === 0,
      `${line.id}:reason`,
    ),
  };
}

export function DetailListHeader({
  title,
  summary,
  children,
}: {
  title: string;
  /** The list's total(s). */
  summary: string;
  /** The list's buttons. */
  children: ReactNode;
}) {
  return (
    // The add button keeps its full label; in ru / uz at 360 px it was
    // squeezed and cut off. The row wraps instead.
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-old-h3 font-semibold text-[var(--c-fg)]">{title}</h3>
        <p className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">{summary}</p>
      </div>
      {children}
    </div>
  );
}

export function DetailListEmpty({ children }: { children: ReactNode }) {
  return <EmptyState compact title={children} />;
}

export function DetailLineList({ children }: { children: ReactNode }) {
  return <div className={rowListClass}>{children}</div>;
}

export function DetailLineFrame({
  title,
  removeLabel,
  onRemove,
  children,
}: {
  title: string;
  removeLabel: string;
  /** Absent when the line cannot be removed. */
  onRemove: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-old-label font-semibold text-[var(--c-fg-muted)]">{title}</span>
        {onRemove ? (
          <Button size="sm" variant="danger-ghost" aria-label={removeLabel} onClick={onRemove}>
            {removeLabel}
          </Button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function LineAmountField({
  label,
  name,
  value,
  readOnly,
  problem,
  onLeave,
  onChange,
}: {
  label: string;
  /**
   * DX-CLS-3 (2026-11-01): the field's name carries the line number for a
   * screen reader ("支出 2 · 金额"), and its error says it.
   */
  name: string;
  value: string;
  readOnly: boolean;
  problem: MoneyProblem | null;
  onLeave: () => void;
  onChange: (value: string) => void;
}) {
  const i18n = useI18n();
  return (
    <Field
      label={label}
      error={problem ? i18n.t(ITEM_MONEY_PROBLEM_MESSAGE[problem], { field: name }) : null}
    >
      <Input
        type="number"
        value={value}
        placeholder="0"
        readOnly={readOnly}
        aria-label={name}
        formatError="none"
        onBlur={onLeave}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

export function LineReasonField({
  label,
  name,
  historicalText,
  isHistorical,
  value,
  readOnly,
  placeholder,
  missing,
  onLeave,
  onChange,
}: {
  label: string;
  /** As for the amount: the line number and the field. */
  name: string;
  /** Shown instead of the field on a line kept as a historical total. */
  historicalText: string;
  isHistorical: boolean;
  value: string;
  readOnly?: boolean;
  placeholder?: string;
  missing: boolean;
  onLeave: () => void;
  onChange: (value: string) => void;
}) {
  const i18n = useI18n();
  return (
    <Field
      label={label}
      error={
        !isHistorical && missing
          ? i18n.t('settlement.errors.itemReasonEmpty', { field: name })
          : null
      }
    >
      {isHistorical ? (
        <p className="rounded-[var(--r-utility)] bg-[var(--c-surface-3)] px-3 py-2 text-old-body-sm text-[var(--c-fg-muted)]">
          {historicalText}
        </p>
      ) : (
        <Textarea
          value={value}
          maxLength={500}
          readOnly={readOnly}
          aria-label={name}
          placeholder={placeholder}
          onBlur={onLeave}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </Field>
  );
}
