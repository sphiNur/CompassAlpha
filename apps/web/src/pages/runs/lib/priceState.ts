/**
 * How a purchase row should present its price.
 *
 * The operator's ask: "大都数物品价格不是每天都会变化的，只有个别的价格会变，
 * 所以默认不显示价格输入，需要输入价格要点击具体的物品."
 *
 * Most staples cost the same today as last trip, so a full
 * qty × price grid on every one of several hundred rows is noise that
 * pushes the rows that DO need attention off the screen. The row
 * therefore renders one of three ways, and only the one the purchaser
 * taps opens an editor.
 *
 * The safety cost of carrying a price forward is real and is handled
 * separately: `countCarriedOver` feeds the finish sheet, so closing a
 * run states how many prices were accepted unchanged and how many of
 * those references were already old. Without that line this whole
 * feature would just be a faster way to bill a shop last month's price.
 *
 * ⚠ That line depends on something outside this file. Every
 * ItemPurchased inserts a row into inventory.price_history
 * (runProjection.ts), so `lastPriceBySku` in run.get MUST exclude the
 * current run — `AND run_id IS DISTINCT FROM $runId`. It did not until
 * 2026-07-27, and the effect was total rather than partial: the
 * reference for a row the purchaser had just saved WAS the price they
 * had just saved, so every purchased row compared equal and `carried`
 * counted all of them, while `observed_at` was always today and `stale`
 * was structurally 0 — the warning could not fire even once. Proven on
 * a live instance with a price retyped from 70,000 to 105,000, which
 * reported as carried-over-unchecked.
 *
 * Nothing in this file can detect that; both halves keep returning
 * plausible numbers. If you touch that query, re-verify against a run
 * that mixes changed and unchanged prices.
 */

/** Reference prices go stale; a fortnight-old market price is a guess. */
export const STALE_PRICE_DAYS = 7;

export type PriceRowState =
  /** Pending, has a reference price, purchaser hasn't touched it. */
  | 'carried'
  /** Pending, no reference price anywhere — must be typed. */
  | 'unpriced'
  /** Purchaser opened the editor on this row (or already saved). */
  | 'editing';

export function priceRowState(args: {
  status: string;
  lastPrice: string | null;
  expanded: boolean;
}): PriceRowState {
  if (args.expanded) return 'editing';
  if (args.status !== 'pending') return 'editing';
  // Number(), not truthiness: the string "0" (and "0.00", and any
  // garbage that parses to NaN) is truthy, so a zero reference rendered
  // the one-tap 'carried' row complete with a ✓ — while canSave, which
  // requires Number(price) > 0, kept that ✓ permanently grey with
  // nothing on the row to explain why. A price that cannot be saved is
  // not a price to carry forward.
  return Number(args.lastPrice) > 0 ? 'carried' : 'unpriced';
}

/** Whole days between an ISO timestamp and `now`; null when unknown. */
export function priceAgeDays(observedAt: string | null | undefined, now: number): number | null {
  if (!observedAt) return null;
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) return null;
  // Future timestamps (clock skew between the phone and the server)
  // are treated as fresh rather than negative-aged.
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export function isStalePrice(observedAt: string | null | undefined, now: number): boolean {
  const days = priceAgeDays(observedAt, now);
  return days !== null && days > STALE_PRICE_DAYS;
}

export type CarriedOverSummary = {
  /** Purchased rows whose unit price equals the reference exactly. */
  carried: number;
  /** Of those, how many references were already stale. */
  stale: number;
};

/**
 * How much of this run was billed at a price nobody re-checked.
 *
 * Deliberately derived by COMPARING the saved price to the reference
 * rather than by tracking taps. A flag would be per-device state that a
 * reload loses, and it would answer the wrong question anyway: what the
 * manager approving a run needs to know is not "did someone tap" but
 * "which of these numbers is just last week's number again". An exact
 * match is that, whether it was accepted in one tap or retyped
 * identically.
 */
export function countCarriedOver(
  items: ReadonlyArray<{ skuId: string; status: string; unitPrice?: string | null }>,
  lastPriceBySku: Readonly<Record<string, string>>,
  observedAtBySku: Readonly<Record<string, string>>,
  now: number,
): CarriedOverSummary {
  let carried = 0;
  let stale = 0;
  for (const item of items) {
    if (item.status !== 'purchased' || !item.unitPrice) continue;
    const ref = lastPriceBySku[item.skuId];
    if (!ref) continue;
    // Compare numerically: '7000' and '7000.00' are the same price.
    const a = Number(item.unitPrice);
    const b = Number(ref);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a !== b) continue;
    carried += 1;
    if (isStalePrice(observedAtBySku[item.skuId], now)) stale += 1;
  }
  return { carried, stale };
}
