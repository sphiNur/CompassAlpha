import { memo } from 'react';
import { NameCell, QtyControl } from '@compass/ui';
import { useI18n, type ProductNameParts } from '../../hooks/useI18n';
import { formatQty } from '../../lib/format';
import { ORDER_QTY_MAX } from '@compass/contracts/limits';
import type { UnitLabel } from '../../lib/unitLabel';

/**
 * Memoized SKU row (M3.10, 2026-05-16).
 *
 * Previously the SKU list was inline `filteredSkus.map(sku => <li>…</li>)`
 * inside OrderPage. Tapping +/- on any one row updated the tRPC cache
 * via `utils.order.todaySession.setData`, which triggered a parent
 * re-render — which then re-rendered ALL 187 rows in production
 * (~2-3 ms each on slow iOS WebView = 400-500 ms of work for a single
 * tap).
 *
 * Pulling the row into `React.memo` short-circuits all unaffected
 * rows. The memo compares props shallowly; only the one row whose
 * `myQty` / `totalQty` / `otherContribCount` changed re-renders. Other
 * rows skip render entirely when the parent re-renders for unrelated
 * reasons (search input typing, banner state change, etc.).
 *
 * Stability requirements for the props (so memo isn't busted):
 *   - `productName`: useProductName() now memoizes by locale (M3.10
 *     hook fix) so its reference is stable across renders.
 *   - `onQtyChange`: already useCallback'd at handleQtyChange.
 *   - `i18n`: useI18n() returns a useMemo'd object per locale.
 *   - Other props are primitives or stable references.
 */
type SkuRowSku = {
  id: string;
  names: Record<string, string>;
  unit: string;
  step: string;
};

export const SkuRow = memo(function SkuRow({
  sku,
  archived = false,
  myQty,
  totalQty,
  otherContribCount,
  isReadOnly,
  storeId,
  productNameParts,
  unitLabel,
  i18n,
  onQtyChange,
}: {
  sku: SkuRowSku;
  /** DX-ORD-16: archived but still in my draft — can only go down. The
   *  group heading above says "No longer sold". */
  archived?: boolean;
  myQty: number;
  totalQty: number;
  otherContribCount: number;
  isReadOnly: boolean;
  storeId: string;
  productNameParts: (item: {
    names: Record<string, string> | null | undefined;
  }) => ProductNameParts;
  unitLabel: UnitLabel;
  i18n: ReturnType<typeof useI18n>;
  onQtyChange: (storeId: string, skuId: string, qty: string) => void;
}) {
  // M3.15 (2026-05-16): py-2 → py-1.5 to tighten the SKU row. With
  // the new QtyControl baseline (h-9 = 36 px), the row sits at ~52 px
  // instead of the old ~72 px — matches the bottom-nav rhythm. One
  // more SKU visible per viewport on a 5.5" screen.
  //
  // M3.55 (2026-05-23): user-requested tweaks for the order surface:
  //   - bumped SKU name from text-old-body (13 px) → text-old-h2 (15 px) so
  //     the primary content scans easier on phone screens.
  //   - dropped the redundant `{sku.unit}` caption that used to lead
  //     the secondary line. The unit is already shown inside the
  //     QtyControl pill on the right ("3 kg") so duplicating it here
  //     stole vertical real estate without adding info.
  //   - the secondary line now hides entirely when there's no
  //     suggested qty AND no cross-staff contribution count — most
  //     rows on a fresh order are exactly that case, so the row
  //     collapses to a single line.
  // ORD-20 (2026-10-30): a "suggested qty" line used to sit here too, but
  // nothing ever wrote a suggestion, so it never showed.
  const hasSecondaryLine = otherContribCount > 0 && totalQty > 0;
  const nm = productNameParts(sku);
  return (
    // A11Y-1 (2026-10-31): the row wraps. Below ~7rem for the name (200%
    // zoom makes the row ~195 px wide) the qty control moves under the
    // name instead of squeezing it to nothing; at 320 px it still fits
    // on one line.
    // Perf (2026-11-05): ~300 rows are mounted; content-visibility lets the
    // browser skip layout/paint for rows off screen (iOS 18+ WebView).
    // "auto 50px" (measured row height) is the estimate until a row has
    // been laid out once; afterwards the browser remembers the real one.
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[var(--c-divider)] px-4 py-1.5 last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_50px]">
      <div className="min-w-[7rem] flex-1">
        <NameCell
          primary={nm.primary}
          secondary={nm.secondary}
          primaryLang={nm.primaryLang}
          secondaryLang={nm.secondaryLang}
          size="prominent"
        />
        {hasSecondaryLine ? (
          <div className="mt-0.5 text-old-label leading-tight text-[var(--c-fg-muted)]">
            {otherContribCount > 0 && totalQty > 0 ? (
              <>
                <span className="font-semibold text-[var(--c-fg)]">
                  {i18n.t('order.totalQty', {
                    qty: formatQty(totalQty),
                    unit: unitLabel(sku.unit, totalQty),
                  })}
                </span>{' '}
                ({otherContribCount + (myQty > 0 ? 1 : 0)})
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <QtyControl
        value={myQty}
        step={Number(sku.step)}
        unit={unitLabel.uncounted(sku.unit)}
        unitFor={(qty) => unitLabel(sku.unit, qty)}
        disabled={isReadOnly}
        onChange={(next) => onQtyChange(storeId, sku.id, String(next))}
        // ORD-9 (2026-10-31): the server refuses a line of a million or
        // more; the sheet now says so instead of a retry-forever toast.
        // DX-ORD-16: an archived product can only be reduced (the server
        // refuses adding to it).
        max={archived ? myQty : ORDER_QTY_MAX}
        // M3.55 (2026-05-23): show the SKU name in the qty quick-pick
        // sheet title. Without this the popup was a context-less "Set
        // quantity" — when the user mis-tapped a row, they couldn't
        // tell they'd opened the wrong SKU's picker. Now the title
        // reads e.g. "玉米淀粉" so a wrong row is obvious instantly.
        pickTitle={nm.primary}
        className="ml-auto"
      />
    </li>
  );
});
