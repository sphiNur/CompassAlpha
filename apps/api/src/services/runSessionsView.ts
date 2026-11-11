/**
 * The order sessions a run is planned from, as the run screens show them
 * (review RUNAPI-14).
 *
 * run.previewCreatable, run.historyDetail and run.get each built these
 * from their own copy, one of them "kept in sync manually", and the
 * copies drifted: run.get counted a product twice when two people in one
 * session ordered it, where history and the approval cards count it once.
 */
import { eq, inArray } from 'drizzle-orm';
import { milliQty, qtyMilli } from '@compass/contracts/quantity';
import { schema as s, type DB } from '@compass/db';

/** An extra line typed into an order ("其他物品", M3.16-C), as stored. */
export type SessionExtra = {
  name: string;
  qty: string;
  unit: string;
  note?: string;
  /** M3.37: absent reads as pending. */
  status?: 'pending' | 'bought' | 'unavailable';
};

/** An extra and its place in its session, for `order.markExtraStatus` (M3.37). */
export type RunSessionExtra = SessionExtra & {
  sessionId: string;
  idx: number;
  /** The session's lastSeq, sent back as markExtraStatus's expectedSeq (APR-18). */
  sessionSeq: number;
};

/** The columns of a session these views read. */
export type RunSessionRecord = {
  id: string;
  storeId: string;
  notes: string | null;
  extrasJson: unknown;
  submittedByMemberId: string | null;
  initiatedByMemberId: string | null;
  status: string;
  lastSeq: number;
};

/** One order line of a session. */
export type SessionItem = { sessionId: string; skuId: string; qty: string };

/** How much of a product a store's sessions asked for. */
export type StoreDemand = { storeId: string; skuId: string; qty: string };

/** A session as run.get and run.historyDetail list it. */
export type RunSessionRow = {
  id: string;
  storeId: string;
  submittedByMemberId: string | null;
  initiatedByMemberId: string | null;
  submittedByDisplayName: string | null;
  /** Products ordered, each counted once. */
  itemCount: number;
  totalQty: string;
  extrasCount: number;
  status: string;
};

/** A session's extras as stored; anything but an array reads as none. */
export function storedExtras(extrasJson: unknown): SessionExtra[] {
  return Array.isArray(extrasJson) ? (extrasJson as SessionExtra[]) : [];
}

/**
 * Per store, the sessions' notes joined by a blank line (M1.8, the
 * legacy free text) and their extras in session order. A store with
 * neither is left out.
 */
export function notesAndExtrasByStore(
  sessions: readonly Pick<
    RunSessionRecord,
    'id' | 'storeId' | 'notes' | 'extrasJson' | 'lastSeq'
  >[],
): {
  sessionNotesByStore: Record<string, string>;
  sessionExtrasByStore: Record<string, RunSessionExtra[]>;
} {
  const notes = new Map<string, string[]>();
  const extras = new Map<string, RunSessionExtra[]>();
  for (const session of sessions) {
    const note = (session.notes ?? '').trim();
    if (note) {
      const list = notes.get(session.storeId);
      if (list) list.push(note);
      else notes.set(session.storeId, [note]);
    }
    const stored = storedExtras(session.extrasJson);
    if (stored.length === 0) continue;
    const list = extras.get(session.storeId) ?? [];
    stored.forEach((extra, idx) =>
      list.push({ ...extra, sessionId: session.id, idx, sessionSeq: session.lastSeq }),
    );
    extras.set(session.storeId, list);
  }
  return {
    sessionNotesByStore: Object.fromEntries(
      [...notes].map(([storeId, list]) => [storeId, list.join('\n\n')]),
    ),
    sessionExtrasByStore: Object.fromEntries(extras),
  };
}

type SessionSender = Pick<RunSessionRecord, 'submittedByMemberId' | 'initiatedByMemberId'>;

/** Who sent a session: the member who submitted it, else who started it. */
export function sessionSenderId(session: SessionSender): string | null {
  return session.submittedByMemberId ?? session.initiatedByMemberId;
}

/** The display names of the members who sent these sessions, by member id. */
export async function senderNames(
  db: DB,
  sessions: readonly SessionSender[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      sessions.map((session) => sessionSenderId(session)).filter((id): id is string => !!id),
    ),
  ];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const rows = await db
    .select({ memberId: s.members.id, displayName: s.users.displayName })
    .from(s.members)
    .innerJoin(s.users, eq(s.users.id, s.members.userId))
    .where(inArray(s.members.id, ids));
  for (const row of rows) names.set(row.memberId, row.displayName);
  return names;
}

/** The name of whoever sent `session`, from `senderNames`. */
export function senderName(names: ReadonlyMap<string, string>, session: SessionSender) {
  const id = sessionSenderId(session);
  return id ? (names.get(id) ?? null) : null;
}

/**
 * What the sessions asked for: per store and product (the run page fills
 * its store fields from this), and per session the products and their
 * total quantity. In whole thousandths (RUNAPI-05). Lines of zero or
 * less, and lines of a session not in `sessions`, are left out.
 */
export function sessionDemand(
  sessions: readonly Pick<RunSessionRecord, 'id' | 'storeId'>[],
  items: readonly SessionItem[],
): {
  perStoreDemand: StoreDemand[];
  bySession: Map<string, { itemCount: number; totalQty: string }>;
} {
  const storeOf = new Map(sessions.map((session) => [session.id, session.storeId]));
  const demand = new Map<string, { storeId: string; skuId: string; milli: bigint }>();
  const perSession = new Map<string, { skuIds: Set<string>; milli: bigint }>();
  for (const item of items) {
    const storeId = storeOf.get(item.sessionId);
    if (storeId === undefined) continue;
    const milli = qtyMilli(item.qty);
    if (milli <= 0n) continue;
    const key = `${storeId}|${item.skuId}`;
    const line = demand.get(key);
    if (line) line.milli += milli;
    else demand.set(key, { storeId, skuId: item.skuId, milli });
    const session = perSession.get(item.sessionId);
    if (session) {
      session.skuIds.add(item.skuId);
      session.milli += milli;
    } else {
      perSession.set(item.sessionId, { skuIds: new Set([item.skuId]), milli });
    }
  }
  return {
    perStoreDemand: [...demand.values()].map(({ storeId, skuId, milli }) => ({
      storeId,
      skuId,
      qty: milliQty(milli),
    })),
    bySession: new Map(
      [...perSession].map(([sessionId, { skuIds, milli }]) => [
        sessionId,
        { itemCount: skuIds.size, totalQty: milliQty(milli) },
      ]),
    ),
  };
}

/**
 * The run's sessions a reader may see (all of them when `visibleStoreIds`
 * is null), with their order lines.
 */
export async function loadRunSessions(
  db: DB,
  sessionIds: readonly string[],
  visibleStoreIds: ReadonlySet<string> | null,
): Promise<{ sessions: RunSessionRecord[]; items: SessionItem[] }> {
  if (sessionIds.length === 0) return { sessions: [], items: [] };
  const all = await db.query.orderSessionsV.findMany({
    where: (session, { inArray: inList }) => inList(session.id, [...sessionIds]),
    columns: {
      id: true,
      storeId: true,
      notes: true,
      extrasJson: true,
      submittedByMemberId: true,
      initiatedByMemberId: true,
      status: true,
      lastSeq: true,
    },
  });
  const sessions = visibleStoreIds
    ? all.filter((session) => visibleStoreIds.has(session.storeId))
    : all;
  const items =
    sessions.length === 0
      ? []
      : await db.query.orderItemsV.findMany({
          where: (item, { inArray: inList }) =>
            inList(
              item.sessionId,
              sessions.map((session) => session.id),
            ),
          columns: { sessionId: true, skuId: true, qty: true },
        });
  return { sessions, items };
}

/**
 * What run.get and run.historyDetail show of the sessions `loadRunSessions`
 * returned: the session list, each store's demand, notes and extras.
 */
export async function runSessionsView(
  db: DB,
  sessions: readonly RunSessionRecord[],
  items: readonly SessionItem[],
): Promise<{
  sessions: RunSessionRow[];
  perStoreDemand: StoreDemand[];
  sessionNotesByStore: Record<string, string>;
  sessionExtrasByStore: Record<string, RunSessionExtra[]>;
}> {
  const { perStoreDemand, bySession } = sessionDemand(sessions, items);
  const names = await senderNames(db, sessions);
  return {
    sessions: sessions.map((session) => ({
      id: session.id,
      storeId: session.storeId,
      submittedByMemberId: session.submittedByMemberId,
      initiatedByMemberId: session.initiatedByMemberId,
      submittedByDisplayName: senderName(names, session),
      itemCount: bySession.get(session.id)?.itemCount ?? 0,
      totalQty: bySession.get(session.id)?.totalQty ?? '0',
      extrasCount: storedExtras(session.extrasJson).length,
      status: session.status,
    })),
    perStoreDemand,
    ...notesAndExtrasByStore(sessions),
  };
}
