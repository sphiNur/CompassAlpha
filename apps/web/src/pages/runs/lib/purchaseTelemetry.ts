import { getLogger } from '@compass/telemetry';
import type { PaymentMethod } from '@compass/contracts';

/**
 * Purchaser-screen telemetry (2026-11-05).
 *
 * A baseline for judging changes to the purchaser screen: how each line
 * gets entered at the market. The event log already says WHEN a line was
 * bought (see scripts/sql/purchase-metrics.sql); this adds what only the
 * screen knows — how long the editor was open, whether the one-tap ✓ or
 * the editor was used, whether the carried price/qty were changed,
 * whether the phone was offline.
 *
 * No amounts, product names or ids leave the device: durations, flags
 * and counts only. Lands in ops.client_logs (kept 30 days).
 */
export type EntrySource = 'editor' | 'collapsed';

export function logPurchaseEntry(d: {
  source: EntrySource;
  /** Editor open → save, ms; null for the one-tap ✓. */
  msInEditor: number | null;
  priceChanged: boolean;
  qtyChanged: boolean;
  hadLastPrice: boolean;
  inThousands: boolean;
  method: PaymentMethod;
  multiStore: boolean;
}): void {
  getLogger().log('info', 'purchase.entry', {
    action: d.source,
    data: {
      msInEditor: d.msInEditor,
      priceChanged: d.priceChanged,
      qtyChanged: d.qtyChanged,
      hadLastPrice: d.hadLastPrice,
      inThousands: d.inThousands,
      method: d.method,
      multiStore: d.multiStore,
      online: typeof navigator === 'undefined' ? null : navigator.onLine,
    },
  });
}

/** A line marked "not available"; `msInEditor` null when marked from the collapsed row. */
export function logPurchaseUnavailable(msInEditor: number | null): void {
  getLogger().log('info', 'purchase.unavailable', { data: { msInEditor } });
}

/** The editor was opened and closed again without saving. */
export function logPurchaseAbandon(msInEditor: number): void {
  getLogger().log('info', 'purchase.abandon', { data: { msInEditor } });
}
