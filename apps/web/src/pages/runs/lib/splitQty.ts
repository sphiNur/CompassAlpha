/**
 * Splitting one quantity across several stores.
 *
 * Both helpers work in whole thousandths, the precision of the
 * `decimal(12,3)` qty columns, because the domain validates
 * `Math.abs(splitSum - qty) <= TOLERANCE` on every command that carries
 * splits: the parts sum to the whole exactly rather than within
 * tolerance. Review RUNWEB2-14 (2026-11-11): they read and print
 * quantities with @compass/contracts/quantity, as every other quantity
 * is, instead of private copies ("2.500" here, "2.5" elsewhere).
 */
import { milliQty, qtyMilliOrZero } from '@compass/contracts/quantity';

/**
 * Equal shares of `totalQty` across `storeIds`.
 *
 * This used to be `Math.floor(q / storeIds.length)`, which is integer
 * division on a value that is almost never an integer. Shared run costs
 * — porters, a taxi, the market fee — are entered as 1 x 30,000, and 1
 * is the quantity the sheet opens with. So:
 *
 *   floor(1 / 3) = 0  ->  { A: '0', B: '0', C: '1' }
 *
 * and the submit path drops zero-quantity splits, so the whole 30,000
 * was billed to store C while the sheet said "3 selected · split
 * evenly". Every shared cost recorded the default way landed entirely
 * on one store, and nobody reconciles expenses line by line — they read
 * the per-store total — so one store was over-billed on every trip and
 * the other two under-billed.
 *
 * Dividing properly gives 0.333 / 0.333 / 0.334, i.e. 9,990 + 9,990 +
 * 10,020 on a 30,000 cost. The 30 UZS spread is below the smallest note
 * in circulation and the total is exact.
 */
export function evenSplitQty(
  storeIds: readonly string[],
  totalQty: string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (storeIds.length === 0) return out;

  const q = qtyMilliOrZero(totalQty);
  if (q <= 0n) {
    // No usable quantity yet — register each store with a blank so the
    // chips render, and let the caller's canSubmit gate do its job.
    for (const id of storeIds) out.set(id, '');
    return out;
  }

  if (storeIds.length === 1) {
    // Pass the string through untouched so a hand-typed "2." is not
    // rewritten under the user's cursor.
    out.set(storeIds[0]!, totalQty);
    return out;
  }

  // Each share is q / n rounded half-up to a thousandth, and the last
  // store takes what is left. A share so large that the others would
  // take more than the whole (0.002 across 4) is rounded down instead.
  const n = BigInt(storeIds.length);
  let share = (q * 2n + n) / (n * 2n);
  if (share * (n - 1n) > q) share = q / n;
  for (let i = 0; i < storeIds.length - 1; i++) out.set(storeIds[i]!, milliQty(share));
  out.set(storeIds[storeIds.length - 1]!, milliQty(q - share * (n - 1n)));
  return out;
}

/**
 * Scale each store's planned demand to the quantity actually bought.
 *
 * "如果同一种物品多店铺都要购买,而出于各种原因购买数量重量与店铺申请的
 *  不一样,这个需要能在写价格的时候就能更改。我们只需要写单价,根据具体的
 *  总价来自动计算"
 *
 * Three stores planning 1 + 1.5 + 0.5 kg who only got 2 kg become
 * 0.667 + 1.0 + 0.333.
 *
 * DX-BUY-3 (2026-11-01): largest remainder, in whole steps. BUY-13
 * rounded every share DOWN to the product's step and gave the rest to
 * the last store, so the shortfall always landed on whichever store
 * happened to be first (planned 1.5 + 1.5, bought 2.5 at step 0.5 → 1 +
 * 1.5). Now every store gets the whole steps its share covers, and the
 * steps left over go to the stores with the largest fractions — ties to
 * the store that planned more, then list order. A remainder smaller
 * than one step (bought 2.3 at step 0.5) goes to the next store in that
 * same order. Exact: the arithmetic is in integer thousandths.
 *
 * Returns null when there is nothing to scale — no demand rows (a
 * legacy run recorded before per-store demand existed), a non-positive
 * actual quantity, or a planned total of zero — and when a store would
 * get nothing (the server refuses a 0 split). Callers fall back to the
 * full purchase sheet.
 */
export function proportionalSplitQty(
  demand: ReadonlyArray<{ storeId: string; qty: string }>,
  actualQtyStr: string,
  /** BUY-13 (2026-10-30): the product's order step. Shares are whole
   *  steps (no 5.625 pieces). */
  step?: string,
): Array<{ storeId: string; qty: string }> | null {
  if (demand.length === 0) return null;
  const actualM = qtyMilliOrZero(actualQtyStr);
  if (actualM <= 0n) return null;
  const planned = demand.map((d) => {
    const q = qtyMilliOrZero(d.qty);
    return q > 0n ? q : 0n;
  });
  const plannedM = planned.reduce((s, q) => s + q, 0n);
  if (plannedM <= 0n) return null;

  if (demand.length === 1) {
    return [{ storeId: demand[0]!.storeId, qty: actualQtyStr }];
  }

  const stepM = qtyMilliOrZero(step);
  const unit = stepM > 0n ? stepM : 1n;

  const units = actualM / unit;
  // Each store's exact claim is planned × units / plannedTotal steps:
  // `whole` steps plus a fraction `rest / plannedM`.
  const shares = planned.map((p, index) => {
    const claim = p * units;
    return { index, whole: claim / plannedM, rest: claim % plannedM, planned: p };
  });
  const ranked = [...shares].sort((a, b) =>
    a.rest !== b.rest
      ? a.rest > b.rest ? -1 : 1
      : a.planned !== b.planned
        ? a.planned > b.planned ? -1 : 1
        : a.index - b.index,
  );
  const leftoverUnits = Number(units - shares.reduce((s, x) => s + x.whole, 0n));
  const qtyM = shares.map((x) => x.whole * unit);
  for (let i = 0; i < leftoverUnits; i++) qtyM[ranked[i]!.index]! += unit;
  // Less than one step left (the bought quantity is not a whole number
  // of steps): the next store in line takes it.
  const below = actualM - units * unit;
  if (below > 0n) qtyM[ranked[leftoverUnits % ranked.length]!.index]! += below;

  const out = demand.map((d, i) => ({ storeId: d.storeId, qty: milliQty(qtyM[i]!) }));
  // BUY-13: a store left with nothing (a tiny quantity, or rounding to the
  // step) was sent as "0.000" and refused; let the full sheet decide.
  if (qtyM.some((q) => q <= 0n)) return null;
  return out;
}
