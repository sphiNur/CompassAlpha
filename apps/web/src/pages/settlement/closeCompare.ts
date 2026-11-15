/**
 * UI overhaul E3 (2026-11-15): the day's close next to yesterday's and the
 * same weekday last week. Revenue and paid outflows only — the two numbers
 * an owner reads to see whether the day looked normal. Amounts are compared
 * in integer cents (CLAUDE.md money rule); a change of a third or more is
 * marked so it stands out.
 */
import { moneyToCents } from './draftModel';

/** The two filed figures compared, as the server stores them. */
export type CloseFigures = {
  onlineRevenue: string;
  invoicedCashRevenue: string;
  operatingExpenses: string;
  wagesPaid: string;
};

export type CompareMetric = 'totalRevenue' | 'paidOutflows';

/** A change this large (either way, in percent) is highlighted. */
export const UNUSUAL_CHANGE_PERCENT = 30;

export interface MetricChange {
  /** Whole percent, rounded; null when the earlier day was 0. */
  percent: number | null;
  /** Today minus the earlier day, in cents. */
  deltaCents: bigint;
  unusual: boolean;
}

function sumCents(...values: string[]): bigint | null {
  let total = 0n;
  for (const value of values) {
    const cents = moneyToCents(String(value ?? ''));
    if (cents === null) return null;
    total += cents;
  }
  return total;
}

/** Revenue / paid outflows of a filed close, in cents. */
export function closeMetricCents(close: CloseFigures, metric: CompareMetric): bigint | null {
  return metric === 'totalRevenue'
    ? sumCents(close.onlineRevenue, close.invoicedCashRevenue)
    : sumCents(close.operatingExpenses, close.wagesPaid);
}

/** The draft's figure (a number from the summary) in cents. */
export function numberToCents(value: number | null): bigint | null {
  if (value === null || !Number.isFinite(value)) return null;
  return BigInt(Math.round(value * 100));
}

export function metricChange(current: bigint | null, earlier: bigint | null): MetricChange | null {
  if (current === null || earlier === null) return null;
  // A figure not filed yet (0) says nothing about the day.
  if (current === 0n) return null;
  const deltaCents = current - earlier;
  if (earlier === 0n) return { percent: null, deltaCents, unusual: true };
  // Round half away from zero on whole percent, in integers.
  const scaled = (deltaCents * 200n) / earlier;
  const percent = Number(scaled >= 0n ? (scaled + 1n) / 2n : (scaled - 1n) / 2n);
  return { percent, deltaCents, unusual: Math.abs(percent) >= UNUSUAL_CHANGE_PERCENT };
}
