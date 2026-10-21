/**
 * Store-scoped revisions of a purchased run item.
 *
 * 2026-10-21: run.get redacts what a store-scoped reader sees — splits for
 * stores outside their read scope are dropped, and when any split is
 * hidden the item's supplier and receipt come back as null (see the
 * `allowedStoreSet` branch of run.get). RevisePurchase, however, replaces
 * the item's actualQty and ALL of its storeSplits with whatever the client
 * sends. A reader who can still revise (write permission is resolved
 * separately from read scope — e.g. a global run.purchase with a
 * store-level deny on run.create.org) would therefore silently delete the
 * hidden stores' allocations, shrink the purchased quantity, and wipe the
 * supplier/receipt they were never shown.
 *
 * `mergeScopedRevision` rebuilds the revision so it only touches what the
 * actor could see:
 *   - splits for stores outside the scope are refused;
 *   - hidden splits are carried over unchanged, with their EFFECTIVE price
 *     and payment method materialised as per-split overrides, so the
 *     actor's new item-level price can't reprice stores they can't see;
 *   - actualQty grows by the hidden quantity so the split sum still holds;
 *   - supplier and receipt the actor was shown as null are kept.
 *
 * `scope === null` means unrestricted: the input is returned untouched.
 */

export type ScopedSplit = {
  storeId: string;
  qty: string;
  unitPrice?: string;
  paymentMethod?: 'cash' | 'transfer';
};

export type ScopedRevisionItem = {
  supplierId: string | null;
  unitPrice: string | null;
  paymentMethod: 'cash' | 'transfer' | null;
  receiptPhotoUrl: string | null;
  storeSplits: ScopedSplit[];
};

export type ScopedRevisionInput = {
  supplierId: string | null | undefined;
  actualQty: string;
  receiptPhotoUrl: string | null | undefined;
  storeSplits: ScopedSplit[];
};

export class StoreOutOfScopeError extends Error {
  constructor(readonly storeId: string) {
    super('run.errors.notVisible');
  }
}

/** Exact decimal addition for non-negative decimal strings. */
export function addDecimalStrings(values: readonly string[]): string {
  if (values.length === 0) return '0';
  const scale = values.reduce((max, value) => {
    const point = value.indexOf('.');
    return Math.max(max, point < 0 ? 0 : value.length - point - 1);
  }, 0);
  let total = 0n;
  for (const value of values) {
    const [whole = '0', fraction = ''] = value.split('.');
    total += BigInt(`${whole || '0'}${fraction.padEnd(scale, '0')}`);
  }
  if (scale === 0) return total.toString();
  const digits = total.toString().padStart(scale + 1, '0');
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  const whole = digits.slice(0, -scale);
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Splits of `item` the actor cannot see (empty when unrestricted). */
export function hiddenSplits(
  item: Pick<ScopedRevisionItem, 'storeSplits'>,
  scope: ReadonlySet<string> | null,
): ScopedSplit[] {
  if (scope === null) return [];
  return item.storeSplits.filter((split) => !scope.has(split.storeId));
}

export function mergeScopedRevision<T extends ScopedRevisionInput>(
  item: ScopedRevisionItem,
  input: T,
  scope: ReadonlySet<string> | null,
): T {
  if (scope === null) return input;
  for (const split of input.storeSplits) {
    if (!scope.has(split.storeId)) throw new StoreOutOfScopeError(split.storeId);
  }
  const hidden = hiddenSplits(item, scope);
  if (hidden.length === 0) return input;

  const carried: ScopedSplit[] = hidden.map((split) => {
    const unitPrice = split.unitPrice ?? item.unitPrice ?? undefined;
    const paymentMethod = split.paymentMethod ?? item.paymentMethod ?? undefined;
    return {
      storeId: split.storeId,
      qty: split.qty,
      ...(unitPrice !== undefined ? { unitPrice } : {}),
      ...(paymentMethod !== undefined ? { paymentMethod } : {}),
    };
  });

  return {
    ...input,
    actualQty: addDecimalStrings([input.actualQty, ...hidden.map((split) => split.qty)]),
    storeSplits: [...input.storeSplits, ...carried],
    // run.get returned these as null to this actor; null here means
    // "not shown", not "clear it".
    supplierId: input.supplierId ?? item.supplierId,
    receiptPhotoUrl: input.receiptPhotoUrl ?? item.receiptPhotoUrl,
  };
}
