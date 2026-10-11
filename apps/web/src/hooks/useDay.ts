import { trpc } from '../lib/trpc';
import { useStoreContext } from '../components/StoreSwitcher';

const FRESH = { refetchOnMount: 'always' } as const;
const OPEN = ['planned', 'purchasing', 'delivering', 'amending'];

/** The calendar day where the phone is, as the server writes run dates. */
function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface DaySpend {
  total: number;
  cash: number;
  transfer: number;
  /** One entry per store that was bought for, largest first. */
  stores: Array<{ storeId: string; name: string; total: number }>;
}

export interface DayProgress {
  status: string;
  /** Lines decided one way or the other: bought, or not to be had. */
  done: number;
  lines: number;
}

export interface Day {
  /** Null for someone who may not see prices. */
  spend: DaySpend | null;
  /** Null when nothing is being bought right now. */
  progress: DayProgress | null;
  /** Purchases finished today. */
  finished: number;
}

/**
 * What today has cost and how far the buying has got: the two things
 * Today is about.
 *
 * Today's purchases are those dated or finished today, plus one still
 * open from an earlier date, since money is still going out on it. Amounts are only
 * added up for stores where this person may see prices.
 */
export function useDay({ purchases, prices }: { purchases: boolean; prices: boolean }): Day {
  const ctx = useStoreContext();
  const runs = trpc.run.list.useQuery(undefined, { ...FRESH, enabled: purchases });
  // The purchase record's own question, so the answer is the same in both.
  const priced = trpc.catalog.stores.useQuery({ permission: 'prices.view' }, { enabled: prices });

  const today = localDate();
  const todays = (runs.data ?? []).filter(
    (r) =>
      r.status !== 'cancelled' &&
      (r.runDate === today ||
        OPEN.includes(r.status) ||
        (!!r.finishedAt && localDate(new Date(r.finishedAt)) === today)),
  );
  const open = todays.find((r) => OPEN.includes(r.status)) ?? null;
  const detail = trpc.run.get.useQuery(
    { runId: open?.id ?? '' },
    { ...FRESH, enabled: purchases && !!open },
  );

  let spend: DaySpend | null = null;
  if (prices && priced.data) {
    const names = new Map(priced.data.map((st) => [st.id, st.name.trim()]));
    const byStore = new Map<string, number>();
    spend = { total: 0, cash: 0, transfer: 0, stores: [] };
    for (const run of todays) {
      for (const st of run.storeTotals) {
        if (!names.has(st.storeId)) continue;
        if (ctx.kind === 'specific' && st.storeId !== ctx.storeId) continue;
        spend.total += Number(st.total);
        spend.cash += Number(st.cash);
        spend.transfer += Number(st.transfer);
        byStore.set(st.storeId, (byStore.get(st.storeId) ?? 0) + Number(st.total));
      }
    }
    spend.stores = [...byStore.entries()]
      .map(([storeId, total]) => ({ storeId, name: names.get(storeId) ?? '', total }))
      .sort((a, b) => b.total - a.total);
  }

  let progress: DayProgress | null = null;
  if (open) {
    const items = detail.data?.id === open.id ? detail.data.items : [];
    progress = {
      status: open.status,
      done: items.filter((i) => i.status !== 'pending').length,
      lines: items.length,
    };
  }

  return {
    spend,
    progress,
    finished: todays.filter((r) => r.status === 'finished').length,
  };
}
