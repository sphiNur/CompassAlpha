/**
 * What the run's phase deciders share (review RUNAPI-13): the actor, the
 * start of every event a command emits, and the checks more than one
 * command makes.
 */
// RUNAPI-31: the money module only; the package root brings every zod contract.
import { lineWithinCap, MAX_LINE_AMOUNT } from '@compass/contracts/money';
import { isCalendarDate } from '@compass/contracts/schemas/common';
import { forbidden, preconditionFailed, validation } from '../../shared/errors';
import type { RunState } from '../state';

export interface ActorCtx {
  userId: string;
  memberId: string;
  permissions: ReadonlySet<string>;
}

export type StoreSplitCommand = {
  storeId: string;
  qty: string;
  unitPrice?: string;
  paymentMethod?: 'cash' | 'transfer';
};

/**
 * The stream, seq, time and actor of the `offset`-th event a command
 * emits (1 for its first): decideRun builds it from the state, the
 * command's actor and the clock.
 */
export type EventBase = (offset: number) => {
  streamId: string;
  seq: number;
  occurredAt: Date;
  actorUserId: string;
  actorMemberId: string;
};

export const TOLERANCE = 1e-6;

export function assertActive(state: RunState): void {
  if (state.status === 'absent') throw preconditionFailed('run.errors.streamMissing');
}

/**
 * A day a run's spend can be booked under: one the calendar has
 * (2026-02-31 would roll into March) and not one that has not come yet in
 * the org's time zone (2026-10-21 CA-03 for a new run, HIS-7 for a moved
 * one). The caller gives `today`: it knows the org's time zone, the
 * domain does not (review RUNAPI-13; the routers checked this themselves).
 */
export function assertRunDate(runDate: string, today: string): void {
  if (!isCalendarDate(runDate)) throw validation('run.errors.invalidRunDate');
  if (runDate > today) throw validation('run.errors.runDateInFuture');
}

/**
 * Review RUNAPI-02 (2026-11-09): while the goods are going out, no line
 * may go back to "still to buy". Buying and "won't be bought" are frozen
 * once delivery starts (StartDelivery requires every line handled), so a
 * line put back then had no way forward: it could not be bought, marked
 * again, or taken back to purchasing once a store had its goods, and the
 * run finished with it still pending. Back to purchase first.
 */
export function assertListOpen(state: RunState): void {
  if (state.status === 'delivering') {
    throw preconditionFailed('run.errors.listFrozenWhileDelivering');
  }
}

/**
 * Post-finish amendment gate (2026-07-06). A finished run reopened to
 * `amending` unlocks the normal edit commands, but ONLY for actors
 * holding `run.amend` (super-admin). Everyone else still hits the frozen
 * wall. Cancelled stays permanently frozen. Returns nothing; throws the
 * appropriate precondition/forbidden on a blocked edit.
 */
export function assertEditablePhase(state: RunState, actor: ActorCtx): void {
  if (state.status === 'cancelled') {
    throw preconditionFailed('run.errors.runFrozen', { status: state.status });
  }
  if (state.status === 'finished') {
    // Finished runs are frozen; a super-admin must ReopenRun first.
    throw preconditionFailed('run.errors.runFrozen', { status: state.status });
  }
  if (state.status === 'amending' && !actor.permissions.has('run.amend')) {
    throw forbidden('run.errors.cannotAmend');
  }
}

/**
 * 2026-10-21 audit CA-29: every split must target a store the run serves.
 *
 * The domain state only learns stores from purchased splits and delivery
 * records, so on a run with nothing bought yet that derived set is empty
 * and any storeId used to slip through. The API therefore passes
 * `runStoreIds` (the stores of the run's order sessions), which is the
 * authoritative scope; stores that already hold a delivery record stay
 * allowed so a legacy run can still be corrected. Without `runStoreIds`
 * the old derived-set check applies (empty set → no check).
 */
export function assertStoresWithinRun(
  state: RunState,
  splits: ReadonlyArray<{ storeId: string }>,
  runStoreIds: readonly string[] | undefined,
): void {
  const allowed = new Set<string>(runStoreIds ?? []);
  if (!runStoreIds) {
    for (const it of state.items.values()) {
      for (const sp of it.storeSplits) allowed.add(sp.storeId);
    }
  }
  for (const st of state.stores.keys()) allowed.add(st);
  if (!runStoreIds && allowed.size === 0) return;
  for (const sp of splits) {
    if (!allowed.has(sp.storeId)) {
      throw preconditionFailed('run.errors.storeNotInRun', { storeId: sp.storeId });
    }
  }
}

export function assertSplitOverrides(splits: StoreSplitCommand[]): void {
  for (const split of splits) {
    if (split.unitPrice !== undefined) {
      const price = num(split.unitPrice, 'run.errors.priceFormat');
      if (price <= 0) throw validation('run.errors.priceFormat');
    }
  }
}

/**
 * R2-ENG-2 (2026-10-31): qty and price each had a format limit but their
 * product did not — a line of ~1e21 was accepted, and run.get and the
 * report then disagreed on its total. D1 caps one money line at
 * MAX_LINE_AMOUNT (well inside numeric(14,2) sums of a run).
 */
export function assertLineCap(
  unitPrice: string,
  qty: string,
  splits: ReadonlyArray<{ qty: string; unitPrice?: string }>,
): void {
  const lines: Array<[string, string]> = [[qty, unitPrice]];
  for (const split of splits) lines.push([split.qty, split.unitPrice ?? unitPrice]);
  for (const [lineQty, linePrice] of lines) {
    let within: boolean;
    try {
      within = lineWithinCap(lineQty, linePrice);
    } catch {
      throw validation('run.errors.invalidQty', { value: lineQty });
    }
    if (!within) throw validation('run.errors.lineTooLarge', { max: MAX_LINE_AMOUNT });
  }
}

export function num(s: string, errorKey: string): number {
  const v = Number(s);
  if (!Number.isFinite(v)) throw validation(errorKey, { value: s });
  return v;
}

/** A line's top-up still to buy (0 when it has none). */
export function topUpOf(item: { topUpQty?: string | null }): number {
  return Number(item.topUpQty ?? 0);
}
