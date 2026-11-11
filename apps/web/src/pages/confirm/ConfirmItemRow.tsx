/**
 * One delivered line on the receiving page: the product, the quantity, the
 * four verdict chips, and what was reported on it. Review CONF-07: moved
 * out of ConfirmPage.
 */
import { Chip, ChipBar, NameCell } from '@compass/ui';
import { haptic } from '../../lib/telegram';
import { useI18n, useProductNameParts, useUnitLabel } from '../../hooks/useI18n';
import { formatQty } from '../../lib/format';
import { DECISION_LABEL, DECISIONS, type ConfirmDecisionStatus } from './confirmLogic';

export interface ConfirmLine {
  runId: string;
  skuId: string;
  storeId: string;
  qty: string;
  confirmStatus?: string | null;
  confirmNote?: string | null;
  confirmReceivedQty?: string | null;
}

export function ConfirmItemRow({
  line,
  sku,
  locked,
  onDecide,
}: {
  line: ConfirmLine;
  sku: { names: Record<string, string>; unit: string } | undefined;
  /** The store has signed for the delivery: the verdicts are final. */
  locked: boolean;
  /** A chip was chosen: 'ok' is sent at once, a problem opens its form. */
  onDecide: (status: ConfirmDecisionStatus) => void;
}) {
  const i18n = useI18n();
  const productNameParts = useProductNameParts();
  // 2026-07-30 (flow review): the receiving list printed the raw canonical
  // unit ("kg") while Run — the screen the goods just came from — printed
  // "公斤". Same goods, same locale, two spellings.
  const unitLabel = useUnitLabel();
  const nm = sku ? productNameParts(sku) : null;
  const unit = unitLabel(sku?.unit, line.qty);
  // 2026-07-30 (flow review): was `it.confirmStatus ?? 'ok'`, which
  // pre-selected 正常 on every untouched line. The receiver's screen
  // therefore OPENED in the state "everything is fine" — the exact claim
  // the step exists to obtain from them. null now means null: no chip is
  // selected until they choose one.
  const status = (line.confirmStatus ?? null) as ConfirmDecisionStatus | null;
  return (
    <li className="flex flex-col gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        {/* Confirm is the "default" (dense) name tier per the 2026-07-05
            two-tier decision. */}
        <NameCell
          primary={nm ? nm.primary : i18n.t('common.unknownProduct')}
          secondary={nm?.secondary}
          primaryLang={nm?.primaryLang}
          secondaryLang={nm?.secondaryLang}
          size="default"
        />
        <span className="shrink-0 text-old-label tabular-nums text-[var(--c-fg-muted)]">
          {formatQty(line.qty)} {unit}
        </span>
      </div>
      {/* variant="radio" (2026-07-30): now that an undecided line selects
          NOTHING, a tablist with no selected tab would be invalid ARIA. A
          radiogroup with nothing checked is exactly the state we mean. */}
      <ChipBar
        variant="radio"
        // Choosing a status sends it (or opens the problem sheet): arrows
        // only move focus.
        followFocus={false}
        ariaLabel={i18n.t('confirm.status.ariaLabel')}
      >
        {DECISIONS.map((s) => (
          <Chip
            key={s}
            selected={status === s}
            disabled={locked}
            className={locked && status !== s ? 'opacity-40' : undefined}
            onClick={() => {
              // Block any further taps once the store side has been
              // finalized. After StoreConfirmed the API rejects
              // confirmStoreItem (storeAlreadyConfirmed, since the
              // 2026-10-21 audit CA-30 guard); we catch it here so the UI
              // doesn't even try.
              if (locked) return;
              // Block double-tap on the SAME chip — the domain will return
              // [] but we save the round-trip entirely. DLV-9 (2026-10-30):
              // tapping the problem already chosen reopens it to correct
              // the quantity or note.
              if (status === s && s === 'ok') return;
              haptic('light');
              onDecide(s);
            }}
          >
            {i18n.t(DECISION_LABEL[s])}
          </Chip>
        ))}
      </ChipBar>
      {/* 2026-10-21 CA-06: what was booked into stock for a problem line. */}
      {status && status !== 'ok' && line.confirmReceivedQty != null ? (
        <div className="text-old-label font-medium tabular-nums text-[var(--c-warning-fg)]">
          {i18n.t(DECISION_LABEL[status])}
          {' · '}
          {i18n.t('confirm.receivedOf', {
            received: formatQty(line.confirmReceivedQty),
            qty: formatQty(line.qty),
            unit,
          })}
        </div>
      ) : null}
      {line.confirmNote ? (
        <div className="text-old-label text-[var(--c-fg-muted)]">{line.confirmNote}</div>
      ) : null}
    </li>
  );
}
