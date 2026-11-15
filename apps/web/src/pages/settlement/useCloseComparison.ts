/**
 * UI overhaul E3 (2026-11-15): the closes filed the day before and on the
 * same weekday a week before, for the summary's comparison lines. Both
 * are `settlement.get` reads, under the same store rule as the day itself.
 */
import { addDays } from '../../lib/calendarDate';
import { trpc } from '../../lib/trpc';
import type { CloseFigures } from './closeCompare';
import { BUSINESS_DATE } from './draftModel';

export interface CloseComparison {
  yesterday: CloseFigures | null;
  lastWeek: CloseFigures | null;
}

export function useCloseComparison(
  storeId: string | null | undefined,
  date: string,
  enabled: boolean,
): CloseComparison | undefined {
  const ready = enabled && !!storeId && BUSINESS_DATE.test(date);
  const opts = { enabled: ready, staleTime: 5 * 60_000 } as const;
  const yesterday = trpc.settlement.get.useQuery(
    { storeId: storeId ?? '', date: ready ? addDays(date, -1) : date },
    opts,
  );
  const lastWeek = trpc.settlement.get.useQuery(
    { storeId: storeId ?? '', date: ready ? addDays(date, -7) : date },
    opts,
  );
  if (!ready || !yesterday.isSuccess || !lastWeek.isSuccess) return undefined;
  return { yesterday: yesterday.data, lastWeek: lastWeek.data };
}
