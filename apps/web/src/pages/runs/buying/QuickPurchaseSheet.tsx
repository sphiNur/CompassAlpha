import { useEffect, useRef, useState } from 'react';
import { Button, ChoiceGroup, Field, Money, Sheet } from '@compass/ui/kit';
import type { PaymentMethod } from '@compass/ui/kit';
import type { useI18n } from '../../../hooks/useI18n';
import { formatMoney, formatQty, toQtyInput } from '../../../lib/format';
import { fromDisplayPrice, toDisplayPrice } from '../lib/priceMath';
import { PriceUnit } from './PriceUnit';

export interface QuickPurchase {
  qty: string;
  /** In currency units, whatever unit it was typed in. */
  unitPrice: string;
  paymentMethod: PaymentMethod;
}

export interface QuickPurchaseSheetProps {
  name: string;
  unit: string;
  plannedQty: string;
  lastPrice: string | null;
  /** Which stores asked for how much; shown when there is more than one. */
  demand: Array<{ storeName: string; qty: string }>;
  currency: string;
  priceInThousands: boolean;
  onTogglePriceUnit: () => void;
  saving: boolean;
  i18n: ReturnType<typeof useI18n>;
  onClose: () => void;
  onSave: (purchase: QuickPurchase) => void;
  onMarkNa: () => void;
  onOpenAdvanced: () => void;
}

const LAST_METHOD_KEY = 'compass.run.lastPaymentMethod';

/** A purchaser who pays one stall by transfer usually pays the next the same way. */
function lastPaymentMethod(): PaymentMethod {
  try {
    return window.localStorage.getItem(LAST_METHOD_KEY) === 'transfer' ? 'transfer' : 'cash';
  } catch {
    return 'cash';
  }
}

/**
 * Record one purchase: how much, at what price, paid how. This is where
 * the payment method is first decided; every later screen shows it.
 */
export function QuickPurchaseSheet({
  name,
  unit,
  plannedQty,
  lastPrice,
  demand,
  currency,
  priceInThousands,
  onTogglePriceUnit,
  saving,
  i18n,
  onClose,
  onSave,
  onMarkNa,
  onOpenAdvanced,
}: QuickPurchaseSheetProps) {
  const [qty, setQty] = useState(() => toQtyInput(plannedQty));
  // What is typed, in the unit it is typed in. Held as text so that a
  // half-typed "12." survives a render.
  const [price, setPrice] = useState(() =>
    lastPrice ? toDisplayPrice(String(Number(lastPrice)), priceInThousands) : '',
  );
  // Switching the unit rescales the figure: it keeps meaning the same money.
  const unitWas = useRef(priceInThousands);
  useEffect(() => {
    if (unitWas.current === priceInThousands) return;
    unitWas.current = priceInThousands;
    setPrice((shown) =>
      shown && Number.isFinite(Number(shown))
        ? toDisplayPrice(fromDisplayPrice(shown, !priceInThousands), priceInThousands)
        : shown,
    );
  }, [priceInThousands]);
  const unitPrice = fromDisplayPrice(price.trim(), priceInThousands);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(lastPaymentMethod);
  const priceRef = useRef<HTMLInputElement>(null);

  const q = Number(qty);
  const p = Number(unitPrice);
  const valid = Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0;
  const total = valid ? Math.round(q * p) : null;

  const commit = () => {
    if (!valid || saving) return;
    try {
      window.localStorage.setItem(LAST_METHOD_KEY, paymentMethod);
    } catch {
      /* the default simply stays cash */
    }
    onSave({ qty: qty.trim(), unitPrice, paymentMethod });
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={name}
      // Both fields arrive filled in, so focusing one would raise the
      // keyboard over the payment choice for nothing.
      keepFocus
      actions={
        <>
          <Button
            variant="primary"
            data-testid="save-purchase"
            disabled={!valid}
            busy={saving}
            onClick={commit}
          >
            {i18n.t('common.save')}
          </Button>
          <Button onClick={onMarkNa}>{i18n.t('buy.unavailable')}</Button>
          <Button variant="ghost" onClick={onOpenAdvanced}>
            {i18n.t('buy.moreOptions')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-lg">
        {demand.length > 1 ? (
          <p className="text-body text-secondary">
            {demand.map((d) => `${d.storeName} ${formatQty(d.qty)} ${unit}`).join(' · ')}
          </p>
        ) : null}
        <Field
          numeric
          label={i18n.t('buy.qty') as string}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          enterKeyHint="next"
          onKeyDown={(e) => {
            if (e.key === 'Enter') priceRef.current?.focus();
          }}
          suffix={unit}
        />
        <Field
          ref={priceRef}
          numeric
          label={i18n.t('buy.unitPrice', { unit }) as string}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          enterKeyHint="done"
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
          suffix={priceInThousands ? `×1000 ${currency}` : currency}
        />
        <PriceUnit
          typed={price}
          priceInThousands={priceInThousands}
          onTogglePriceUnit={onTogglePriceUnit}
          currency={currency}
          unit={unit}
          i18n={i18n}
        />
        <div className="flex items-baseline justify-between gap-lg">
          <span className="text-body text-secondary">{i18n.t('buy.total')}</span>
          <Money amount={total === null ? '—' : formatMoney(total)} currency={currency} size="lg" />
        </div>
        <ChoiceGroup<PaymentMethod>
          label={i18n.t('run.label.paymentMethod') as string}
          value={paymentMethod}
          onChange={setPaymentMethod}
          options={[
            { value: 'cash', label: i18n.t('run.label.paymentCash') as string },
            { value: 'transfer', label: i18n.t('run.label.paymentTransfer') as string },
          ]}
        />
      </div>
    </Sheet>
  );
}
