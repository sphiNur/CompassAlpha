/**
 * Which of a run's stores the caller may see and act on: the stores a
 * run involves, the read scope, and the checks for creating, amending and
 * running a whole-run command.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import {
  effectivePermissionsForStore,
  getActorStoreIds,
  getActorStoreIdsForPermission,
  resolveRunCreateStoreScope,
} from '../../../services/storeScope';
import { hasGlobalPermission } from '../../../services/orgAdmin';
import type { RequestContext } from '../../context';

/**
 * Resolve every storeId touched by a run's sessions (DISTINCT). Used by
 * run.get / run.list / ejectSession store-scope checks (M3.33 Wave1 #2+#3).
 * The session_ids_json column is the source of truth; sessions can be
 * eject-removed but we deliberately do NOT drop them from the JSON
 * (sessionIds remains the historical attachment ledger). For scope
 * checking we treat both still-attached and historically-attached
 * sessions as "involved" — eject doesn't revoke the operator's right
 * to see what they previously planned for.
 */
export async function runInvolvedStoreIds(
  db: DB,
  run: { sessionIdsJson: string[] },
): Promise<string[]> {
  const sessionIds = run.sessionIdsJson;
  if (sessionIds.length === 0) return [];
  const rows = await db.query.orderSessionsV.findMany({
    where: (sess, { inArray }) => inArray(sess.id, sessionIds),
    columns: { storeId: true },
  });
  return [...new Set(rows.map((r) => r.storeId))];
}

/**
 * Resolve the store slice that may be serialized by live run reads.
 *
 * A persisted GLOBAL `run.create.org` grant gets organization-wide run
 * visibility, subject to store-level denies. A store-scoped copy of that key
 * is only a UI affordance in the flat session union and must not widen the
 * read beyond the member's concrete assignments. A genuine org admin still
 * returns `null` through `getActorStoreIds`.
 */
export async function resolveRunReadStoreScope(
  db: DB,
  ctx: RequestContext,
): Promise<string[] | null> {
  if (await hasGlobalPermission(db, ctx.session!.memberId, 'run.create.org')) {
    return getActorStoreIdsForPermission(
      db,
      ctx.session!.memberId,
      'run.create.org',
      ctx.session!.permissions,
    );
  }
  return getActorStoreIds(db, ctx.session!.memberId, ctx.session!.permissions);
}

export function assertStoreIdsWithinRunCreateScope(
  storeIds: readonly string[],
  allowedStoreIds: readonly string[] | null,
): void {
  if (allowedStoreIds === null) return;
  const allowed = new Set(allowedStoreIds);
  if (storeIds.every((storeId) => allowed.has(storeId))) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.notAssignedToStore',
  });
}

export async function assertRunCreateScopeForRun(
  db: DB,
  ctx: RequestContext,
  run: { sessionIdsJson: string[] },
): Promise<void> {
  const allowedStoreIds = await resolveRunCreateStoreScope(db, ctx.session!);
  if (allowedStoreIds === null) return;
  const involvedStoreIds = await runInvolvedStoreIds(db, run);
  const allowed = new Set(allowedStoreIds);
  if (involvedStoreIds.every((storeId) => allowed.has(storeId))) return;
  throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
}

/**
 * `run.amend` is organization-wide authority over settled money. Prove that
 * it comes from an active GLOBAL persisted grant, then resolve it at every
 * store touched by the run so a store-level deny still wins. A store-scoped
 * role may put `run.amend` in the flat session union, but can never satisfy
 * this gate by itself.
 */
export async function canAmendRun(
  db: DB,
  ctx: RequestContext,
  run: { sessionIdsJson: string[] },
): Promise<boolean> {
  const globallyGranted = await hasGlobalPermission(db, ctx.session!.memberId, 'run.amend');
  if (!globallyGranted) return false;

  const storeIds = await runInvolvedStoreIds(db, run);
  for (const storeId of storeIds) {
    const effective = await effectivePermissionsForStore(
      db,
      ctx.session!.memberId,
      storeId,
      ctx.session!.permissions,
    );
    if (!effective.has('run.amend')) return false;
  }
  return true;
}

export async function assertCanAmendRun(
  db: DB,
  ctx: RequestContext,
  run: { sessionIdsJson: string[] },
): Promise<void> {
  if (await canAmendRun(db, ctx, run)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'run.errors.cannotAmend',
    cause: { missingPermission: 'run.amend' },
  });
}

/**
 * Whole-run mutations affect every store represented by the run. Resolve the
 * command's permission at each concrete store and require full coverage; a
 * permission granted in Store A must never combine with mere membership in
 * Store B to authorize a B-only or A+B mutation. A clean persisted global
 * grant returns `null`, while store-level denies force enumeration and win.
 */
export async function assertRunPermissionForAllStores(
  db: DB,
  ctx: RequestContext,
  run: { sessionIdsJson: string[] },
  permissionKey: string,
  item?: {
    skuId: string;
    splitStoreIds?: readonly string[];
    purchasedStoreIds: readonly string[];
  },
  expenseStoreIds?: readonly string[],
): Promise<void> {
  const allowedStoreIds = await getActorStoreIdsForPermission(
    db,
    ctx.session!.memberId,
    permissionKey,
    ctx.session!.permissions,
  );
  if (allowedStoreIds === null) return;
  const involvedStoreIds = await runInvolvedStoreIds(db, run);
  const allowed = new Set(allowedStoreIds);
  if (involvedStoreIds.length > 0 && involvedStoreIds.every((storeId) => allowed.has(storeId))) {
    return;
  }
  const actsInRun = involvedStoreIds.some((storeId) => allowed.has(storeId));
  if (!actsInRun) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
  }
  // BUY-6 (2026-10-30): a purchaser of some of the run's stores may work
  // on an item that serves only their stores.
  if (item) {
    const itemStoreIds = new Set<string>([
      ...(await itemDemandStoreIds(db, run, item.skuId)),
      ...item.purchasedStoreIds,
      ...(item.splitStoreIds ?? []),
    ]);
    if (itemStoreIds.size > 0 && [...itemStoreIds].every((storeId) => allowed.has(storeId))) {
      return;
    }
    throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.itemServesOtherStores' });
  }
  // D9 (2026-10-31): an expense split only to the actor's stores is theirs
  // to record.
  if (expenseStoreIds) {
    if (expenseStoreIds.length > 0 && expenseStoreIds.every((storeId) => allowed.has(storeId))) {
      return;
    }
    throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.expenseServesOtherStores' });
  }
  // Run-wide steps (start delivery, finish, expenses…) still need every store.
  throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.runHasOtherStores' });
}

/**
 * RE-DLV-3: why `run.finish` (or `run.refinalize` while amending) would
 * refuse this actor, as the error key it would answer with; null when it
 * would not refuse on permission grounds. Same checks as the two
 * mutations, read-only. Other phases answer null: there is nothing to
 * finish yet.
 */
export async function finishBlockedReasonFor(
  db: DB,
  ctx: RequestContext,
  run: { status: string; sessionIdsJson: string[] },
): Promise<string | null> {
  if (run.status === 'amending') {
    return (await canAmendRun(db, ctx, run)) ? null : 'run.errors.cannotAmend';
  }
  if (run.status !== 'delivering') return null;
  if (!ctx.session!.permissions.has('run.finish')) return 'run.errors.cannotFinish';
  const allowedStoreIds = await getActorStoreIdsForPermission(
    db,
    ctx.session!.memberId,
    'run.finish',
    ctx.session!.permissions,
  );
  if (allowedStoreIds === null) return null;
  const allowed = new Set(allowedStoreIds);
  const involvedStoreIds = await runInvolvedStoreIds(db, run);
  if (involvedStoreIds.length > 0 && involvedStoreIds.every((id) => allowed.has(id))) return null;
  return involvedStoreIds.some((id) => allowed.has(id))
    ? 'run.errors.runHasOtherStores'
    : 'run.errors.cannotFinish';
}

/** Stores whose orders in this run ask for `skuId` (BUY-6). */
export async function itemDemandStoreIds(
  db: DB,
  run: { sessionIdsJson: string[] },
  skuId: string,
): Promise<string[]> {
  const sessionIds = run.sessionIdsJson;
  if (sessionIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ storeId: s.orderSessionsV.storeId })
    .from(s.orderItemsV)
    .innerJoin(s.orderSessionsV, eq(s.orderSessionsV.id, s.orderItemsV.sessionId))
    .where(
      and(
        inArray(s.orderItemsV.sessionId, sessionIds),
        eq(s.orderItemsV.skuId, skuId),
        sql`${s.orderItemsV.qty} > 0`,
      ),
    );
  return rows.map((row) => row.storeId);
}
