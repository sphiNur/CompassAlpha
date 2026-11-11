/**
 * The close's wage lines: adding them by hand or from attendance,
 * choosing who each one pays, changing and removing them. Review
 * CONF-06: moved out of SettlementPage.
 */
import { useId, useState } from 'react';
import { Banner, Button, Field, FieldError, IconChevronRight, Select, useToast } from '@compass/ui';
import { SETTLEMENT_DETAIL_ITEMS_MAX as MAX_DETAIL_ITEMS } from '@compass/contracts/limits';
import { trpc } from '../../lib/trpc';
import { haptic } from '../../hooks/useTelegram';
import { useI18n } from '../../hooks/useI18n';
import { confirmThen } from '../../lib/confirm';
import { useErrToast } from '../../lib/errToast';
import { formatMoney } from '../../lib/format';
import { newDetailId, newWageItem, type WageItemDraft } from './draftModel';
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
import { WagePickerSheet, type WagePick } from './WagePickerSheet';

type Lines = WageItemDraft[];

export function WageLines({
  lines,
  update,
  storeId,
  date,
  selectionRequired,
  paidTotal,
  unpaidTotal,
  currency,
  confirmRemoval,
  reveal,
}: {
  lines: Lines;
  /** Changes the lines, from the draft's latest state. */
  update: (change: (lines: Lines) => Lines) => void;
  storeId: string;
  /** The close's business day, for the attendance it is filled from. */
  date: string;
  /**
   * Every line must name a current employee before saving: a new close,
   * or a saved one whose wages changed.
   */
  selectionRequired: boolean;
  /** The paid and unpaid lines' sums, as money text. */
  paidTotal: string;
  unpaidTotal: string;
  currency: string;
  /** Removing a line of a saved close asks first. */
  confirmRemoval: boolean;
  reveal: FieldReveal;
}) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  // A total-only row from before lines were recorded stays as it is (see
  // the expense lines).
  const historical = lines.some((line) => line.isHistorical);
  const atLimit = lines.length >= MAX_DETAIL_ITEMS;
  /** The line whose employee is being chosen. */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /** Set while that line was just added: closing the picker drops it again. */
  const [newPickerFor, setNewPickerFor] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);

  const change = (id: string, patch: Partial<Omit<WageItemDraft, 'id'>>) => {
    update((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const add = () => {
    if (historical) {
      haptic('warning');
      toast.error(i18n.t('settlement.details.historicalReadOnly'));
      return;
    }
    if (atLimit) {
      haptic('warning');
      toast.error(i18n.t('settlement.errors.detailLimit', { count: MAX_DETAIL_ITEMS }));
      return;
    }
    const id = newDetailId();
    haptic('light');
    update((current) => [...current, newWageItem(id)]);
    setNewPickerFor(id);
    setPickerFor(id);
  };

  // Attendance phase 2 (2026-11-05): the day's wages from attendance —
  // daily wage less late / early — as unpaid rows the cashier confirms.
  const fillFromAttendance = async () => {
    if (historical) return;
    setFilling(true);
    try {
      const rows = await utils.attendance.wageSuggestions.fetch({ storeId, date });
      const present = new Set(lines.map((line) => line.memberId).filter(Boolean));
      const payable = rows.filter(
        (r) =>
          r.status === 'payable' &&
          r.amount !== null &&
          Number(r.amount) > 0 &&
          !present.has(r.memberId),
      );
      const review = rows.filter((r) => r.status === 'needsReview' || r.status === 'noRate').length;
      if (payable.length === 0) {
        haptic('warning');
        toast.info(
          review > 0
            ? i18n.t('settlement.wages.fromAttendanceNeedsReview', { n: review })
            : i18n.t('settlement.wages.fromAttendanceNone'),
        );
        return;
      }
      const room = MAX_DETAIL_ITEMS - lines.length;
      const added = payable.slice(0, Math.max(0, room)).map((r) => ({
        id: newDetailId(),
        persistedId: null,
        memberId: r.memberId,
        personName: r.name,
        status: 'unpaid' as const,
        amount: r.amount!,
        reason:
          r.missedMinutes > 0
            ? i18n.t('settlement.wages.fromAttendanceReasonMissed', {
                wage: formatMoney(r.dailyWage, currency),
                late: r.lateMinutes,
                early: r.earlyMinutes,
                missed: r.missedMinutes,
                deduction: formatMoney(r.deduction, currency),
              })
            : r.lateMinutes + r.earlyMinutes > 0
              ? i18n.t('settlement.wages.fromAttendanceReasonDeducted', {
                  wage: formatMoney(r.dailyWage, currency),
                  late: r.lateMinutes,
                  early: r.earlyMinutes,
                  deduction: formatMoney(r.deduction, currency),
                })
              : i18n.t('settlement.wages.fromAttendanceReason', {
                  wage: formatMoney(r.dailyWage, currency),
                }),
        isHistorical: false,
      }));
      haptic('success');
      update((current) => [...current, ...added]);
      // CONF-18: the two sentences join the way the language does (no
      // space after 。 in Chinese).
      const addedText = i18n.t('settlement.wages.fromAttendanceAdded', { n: added.length });
      toast.success(
        review > 0
          ? i18n.t('common.twoSentences', {
              first: addedText,
              second: i18n.t('settlement.wages.fromAttendanceNeedsReview', { n: review }),
            })
          : addedText,
      );
    } catch (err) {
      errToast('settlement.wages.fromAttendanceFailed')(err);
    } finally {
      setFilling(false);
    }
  };

  const remove = (id: string) => {
    if (historical) return;
    const drop = () => {
      haptic('light');
      update((current) => current.filter((line) => line.id !== id));
    };
    if (confirmRemoval) confirmThen(i18n.t('settlement.confirm.removeDetail'), drop);
    else drop();
  };

  const pick = (employee: WagePick) => {
    if (!pickerFor) return;
    change(pickerFor, {
      memberId: employee.memberId,
      personName: employee.displayName,
      isHistorical: false,
    });
    haptic('light');
    setPickerFor(null);
    setNewPickerFor(null);
  };

  const closePicker = () => {
    const abandonedNewLine = newPickerFor === pickerFor ? pickerFor : null;
    if (abandonedNewLine) {
      update((current) => current.filter((line) => line.id !== abandonedNewLine));
    }
    setPickerFor(null);
    setNewPickerFor(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <DetailListHeader
        title={i18n.t('settlement.wages.title')}
        summary={i18n.t('settlement.wages.totals', {
          paid: formatMoney(paidTotal, currency),
          unpaid: formatMoney(unpaidTotal, currency),
        })}
      >
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            loading={filling}
            disabled={historical || atLimit}
            onClick={() => void fillFromAttendance()}
          >
            {i18n.t('settlement.wages.fromAttendance')}
          </Button>
          <Button size="sm" variant="secondary" disabled={historical || atLimit} onClick={add}>
            {i18n.t('settlement.wages.add')}
          </Button>
        </div>
      </DetailListHeader>

      {historical ? (
        <Banner tone="info" title={i18n.t('settlement.details.historicalReadOnly')}>
          {i18n.t('settlement.details.historicalReadOnlyBody')}
        </Banner>
      ) : null}

      {lines.length === 0 ? (
        <DetailListEmpty>{i18n.t('settlement.wages.empty')}</DetailListEmpty>
      ) : (
        <DetailLineList>
          {lines.map((wage, index) => (
            <WageLine
              key={wage.id}
              wage={wage}
              title={i18n.t('settlement.wages.itemNumber', { n: index + 1 })}
              selectionRequired={selectionRequired}
              reveal={reveal}
              onChange={(patch) => change(wage.id, patch)}
              onChoose={() => {
                setPickerFor(wage.id);
                setNewPickerFor(null);
              }}
              onRemove={wage.isHistorical ? undefined : () => remove(wage.id)}
            />
          ))}
        </DetailLineList>
      )}

      <WagePickerSheet
        storeId={storeId}
        lineId={pickerFor}
        chosenMemberId={lines.find((line) => line.id === pickerFor)?.memberId ?? null}
        onPick={pick}
        onClose={closePicker}
      />
    </div>
  );
}

function WageLine({
  wage,
  title,
  selectionRequired,
  reveal,
  onChange,
  onChoose,
  onRemove,
}: {
  wage: WageItemDraft;
  title: string;
  selectionRequired: boolean;
  reveal: FieldReveal;
  onChange: (patch: Partial<Omit<WageItemDraft, 'id'>>) => void;
  onChoose: () => void;
  onRemove: (() => void) | undefined;
}) {
  const i18n = useI18n();
  const problems = lineProblems(wage, reveal);
  const employeeMissing = !wage.isHistorical && selectionRequired && !wage.memberId;
  const employeeErrorId = useId();
  const displayedEmployee = wage.isHistorical
    ? i18n.t('settlement.wages.historicalEmployee')
    : wage.personName || i18n.t('settlement.wages.chooseEmployee');
  return (
    <DetailLineFrame
      title={title}
      removeLabel={i18n.t('settlement.wages.remove')}
      onRemove={onRemove}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={i18n.t('settlement.wages.employee')}>
          <Button
            type="button"
            variant="secondary"
            className="w-full justify-between text-left"
            // 2026-11-11: inside the field's <label> the button was named
            // by the label alone, so a screen reader said "Employee" and
            // never who was chosen.
            aria-label={i18n.t('common.labelValue', {
              label: i18n.t('settlement.wages.employee'),
              value: displayedEmployee,
            })}
            aria-haspopup="dialog"
            aria-invalid={employeeMissing || undefined}
            aria-describedby={employeeMissing ? employeeErrorId : undefined}
            disabled={wage.isHistorical}
            // CONF-11: the arrow is the button's trailing icon. Inside the
            // label's span it sat right after the name, not at the edge.
            trailingIcon={<IconChevronRight size={16} />}
            onClick={onChoose}
          >
            {displayedEmployee}
          </Button>
          {!wage.memberId && wage.personName ? (
            <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('settlement.wages.legacyEmployee')}
            </p>
          ) : null}
          {employeeMissing ? (
            <FieldError id={employeeErrorId}>
              {i18n.t('settlement.errors.employeeRequired')}
            </FieldError>
          ) : null}
        </Field>
        <Field label={i18n.t('settlement.wages.status')}>
          <Select
            value={wage.status}
            disabled={wage.isHistorical}
            onChange={(event) =>
              onChange({
                status: event.currentTarget.value === 'paid' ? 'paid' : 'unpaid',
                isHistorical: false,
              })
            }
          >
            <option value="paid">{i18n.t('settlement.wages.status.paid')}</option>
            <option value="unpaid">{i18n.t('settlement.wages.status.unpaid')}</option>
          </Select>
        </Field>
        <LineAmountField
          label={i18n.t('settlement.wages.amount')}
          name={`${title} · ${i18n.t('settlement.wages.amount')}`}
          value={wage.amount}
          readOnly={wage.isHistorical}
          problem={problems.amount}
          onLeave={() => reveal.leave(`${wage.id}:amount`)}
          onChange={(amount) => onChange({ amount, isHistorical: false })}
        />
      </div>
      <LineReasonField
        label={i18n.t('settlement.wages.reason')}
        name={`${title} · ${i18n.t('settlement.wages.reason')}`}
        historicalText={i18n.t('settlement.wages.historicalReason')}
        isHistorical={wage.isHistorical}
        value={wage.reason}
        placeholder={i18n.t('settlement.wages.reasonPlaceholder')}
        missing={problems.reasonMissing}
        onLeave={() => reveal.leave(`${wage.id}:reason`)}
        onChange={(reason) => onChange({ reason, isHistorical: false })}
      />
    </DetailLineFrame>
  );
}
