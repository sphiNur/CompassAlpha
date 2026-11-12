/**
 * What an order should cost, for the screens that show it before it is
 * bought: the review sheet before sending, and an order's lines on the
 * approval page. Review ORD-11 (2026-11): both wrote this out themselves.
 *
 * The rule is estimateOrder (@compass/contracts), which the server's
 * batch list and approval cards run too (ORD-01), at each product's last
 * price paid. Prices are read for `storeId` (D6): where the reader may
 * not see prices there, none come back and nothing is estimated.
 */
import { useMemo } from 'react';
import { estimateOrder, type OrderEstimate } from '@compass/contracts/money';
import { trpc } from '../lib/trpc';

type Line = { skuId: string; qty: string };

const NO_LINES: readonly Line[] = [];

export function useOrderEstimate(
  lines: readonly Line[] | undefined,
  storeId: string | undefined,
): {
  /** `known` 0: nothing could be priced. */
  estimate: OrderEstimate;
  /** The last price paid for a product, as the estimate used it. */
  lastPriceOf: (skuId: string) => string | undefined;
} {
  const ordered = lines ?? NO_LINES;
  const skuIds = useMemo(
    () => ordered.filter((l) => Number(l.qty) > 0).map((l) => l.skuId),
    [ordered],
  );
  const priceStats = trpc.catalog.skuPriceStats.useQuery(
    { skuIds, storeId },
    { enabled: skuIds.length > 0, staleTime: 60_000 },
  );
  return useMemo(() => {
    const lastPrice = new Map<string, string>();
    for (const r of priceStats.data ?? []) {
      if (r.lastPrice !== null) lastPrice.set(r.skuId, r.lastPrice);
    }
    const lastPriceOf = (skuId: string) => lastPrice.get(skuId);
    return { estimate: estimateOrder(ordered, lastPriceOf), lastPriceOf };
  }, [ordered, priceStats.data]);
}
