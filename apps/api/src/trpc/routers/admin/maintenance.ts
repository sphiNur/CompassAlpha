/**
 * Maintenance: purging test data (the whole workspace, one day, one
 * order, one run) and the lists the targeted purge picks from.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s, type DB } from '@compass/db';
import {
  UuidSchema,
  DateStringSchema,
  PurgeAllTestDataInputSchema,
  PurgeByDateInputSchema,
  PurgeSessionInputSchema,
  PurgeRunInputSchema,
} from '@compass/contracts';
import { milliQty, qtyMilliOrZero } from '@compass/contracts/quantity';
import { dateInTz, todayInTz } from '@compass/domain';
import { authedProcedure } from '../../trpc';
import { bulkPurgeAllowed } from '../../../services/bulkPurge';
import {
  requirePurgeRole,
  runDeleteBlocks,
  runDeleteRefusal,
  sessionDeleteBlocks,
  sessionDeleteRefusal,
} from '../../../services/purgeGuards';
import {
  applyPurge,
  countPurge,
  datePurge,
  refuseIfSettled,
  runPurge,
  sessionPurge,
  workspacePurge,
} from '../../../services/purgePlans';
import { env } from '../../../env';
import { requireAdmin } from './guards';
import { broadcastPurged } from './notify';
import { getAdminReadScope, runTouchesStores } from './scope';
import { auditAdmin } from '../../../services/adminAudit';
import { executeRows } from '../../../services/sqlRows';

/**
 * DX-CAT-5 (2026-11-01): how many orders and runs belong to the reset
 * date, and which ones from other dates go with them because they are
 * linked — orders grouped by date and store, runs by date and number.
 */
async function purgeDateScope(
  tx: DB,
  orgId: string,
  linkedSessionIds: string[],
  linkedRunIds: string[],
  sameDay: { orders: number; runs: number },
): Promise<{
  sameDay: { orders: number; runs: number };
  linkedOrders: Array<{ orderDate: string; storeName: string | null; count: number }>;
  linkedRuns: Array<{ runDate: string; runIndex: number }>;
}> {
  const orders = linkedSessionIds.length
    ? await tx
        .select({
          orderDate: s.orderSessionsV.orderDate,
          storeName: s.stores.name,
          count: sql<number>`count(*)::int`,
        })
        .from(s.orderSessionsV)
        .leftJoin(s.stores, eq(s.stores.id, s.orderSessionsV.storeId))
        .where(
          and(eq(s.orderSessionsV.orgId, orgId), inArray(s.orderSessionsV.id, linkedSessionIds)),
        )
        .groupBy(s.orderSessionsV.orderDate, s.stores.name)
        .orderBy(s.orderSessionsV.orderDate, s.stores.name)
    : [];
  const runs = linkedRunIds.length
    ? await tx
        .select({ runDate: s.marketRunsV.runDate, runIndex: s.marketRunsV.runIndex })
        .from(s.marketRunsV)
        .where(and(eq(s.marketRunsV.orgId, orgId), inArray(s.marketRunsV.id, linkedRunIds)))
        .orderBy(s.marketRunsV.runDate, s.marketRunsV.runIndex)
    : [];
  return {
    sameDay,
    linkedOrders: orders.map((o) => ({
      orderDate: o.orderDate,
      storeName: o.storeName ?? null,
      count: o.count,
    })),
    linkedRuns: runs,
  };
}

/**
 * D2 / R2-CAT-2 (2026-10-31): `requireOnlyTestSessions: false` skips the
 * "someone else wrote or handled it" guard. On production that is the
 * same kind of switch as the bulk purges, so it needs the same opt-in.
 */
function refuseGuardWaiverInProduction(requireOnlyTestSessions: boolean): void {
  if (!requireOnlyTestSessions && !bulkPurgeAllowed(env)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'admin.errors.purgeGuardWaiverDisabledInProduction',
    });
  }
}

/**
 * Grow the purge sets (in place) until no order points at a run outside
 * them and no run outside them holds one of their orders. Only runs that
 * still exist are added; an order whose run is already gone just goes.
 */
async function closeOverRunLinks(
  tx: DB,
  orgId: string,
  sessionIds: string[],
  runIds: string[],
): Promise<void> {
  for (;;) {
    const sessionSet = new Set(sessionIds);
    const runSet = new Set(runIds);
    const ownRuns = sessionIds.length
      ? await tx
          .select({ runId: s.orderSessionsV.runId })
          .from(s.orderSessionsV)
          .innerJoin(s.marketRunsV, eq(s.marketRunsV.id, s.orderSessionsV.runId))
          .where(and(eq(s.orderSessionsV.orgId, orgId), inArray(s.orderSessionsV.id, sessionIds)))
      : [];
    const heldSessions = runIds.length
      ? await tx
          .select({ id: s.orderSessionsV.id })
          .from(s.orderSessionsV)
          .where(and(eq(s.orderSessionsV.orgId, orgId), inArray(s.orderSessionsV.runId, runIds)))
      : [];
    let grew = false;
    for (const r of ownRuns) {
      if (r.runId && !runSet.has(r.runId)) {
        runSet.add(r.runId);
        runIds.push(r.runId);
        grew = true;
      }
    }
    for (const r of heldSessions) {
      if (!sessionSet.has(r.id)) {
        sessionSet.add(r.id);
        sessionIds.push(r.id);
        grew = true;
      }
    }
    if (!grew) return;
  }
}

/**
 * Review ADM2-05: the stores whose orders a purge deletes, read before
 * they go. The audit row lists them as `storeIds`, so it also shows to
 * those stores' admins (auditTouchesStores).
 */
async function storesOfSessions(tx: DB, orgId: string, sessionIds: string[]): Promise<string[]> {
  if (sessionIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ storeId: s.orderSessionsV.storeId })
    .from(s.orderSessionsV)
    .where(and(eq(s.orderSessionsV.orgId, orgId), inArray(s.orderSessionsV.id, sessionIds)));
  return rows.map((r) => r.storeId);
}

export const maintenanceProcedures = {
  // ============ MAINTENANCE / TEST-DATA PURGE ============

  /**
   * Wipe ALL transactional data for the caller's org. Catalog and member
   * rows survive; only what you'd accumulate while testing gets cleared.
   * The tables, and the order they go in, are workspacePurge
   * (services/purgePlans.ts); the preview counts that same list. The
   * admin audit (domain.policy_decisions) is kept (CAT-5), and a
   * workspace with a daily close is refused (CAT-2).
   */
  purgeAllTestData: authedProcedure
    .input(PurgeAllTestDataInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      // Extra gate: only super_admin can purge.
      requirePurgeRole(ctx.session!);
      // D1 (2026-10-30): off on production unless the server opts in.
      if (!bulkPurgeAllowed(env)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.bulkPurgeDisabledInProduction',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const org = await tx.query.organizations.findFirst({
          where: (o, { eq: eq2 }) => eq2(o.id, orgId),
        });
        if (!org) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.orgNotFound' });
        }

        // CAT-2 (2026-10-30): a workspace with a daily close is refused,
        // its preview too.
        await refuseIfSettled(tx, orgId);
        // ADM2-04: the preview counts and the purge deletes the same list.
        const steps = workspacePurge(orgId);
        const counts = await countPurge(tx, steps);
        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        if (input.dryRun) {
          return { dryRun: true, total, byTable: counts, orgSlug: org.slug };
        }

        // Destructive path requires confirmText match. DX-CAT-17
        // (2026-11-01): the workspace's name, which the person can see;
        // the slug is still accepted from older clients.
        const typed = (input.confirmText ?? '').trim();
        if (typed === '' || (typed !== org.name.trim() && typed !== org.slug)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'admin.errors.purgeConfirmMismatch',
          });
        }

        // ADM2-05: every store's records go, so the row names every store
        // and each store's admins see it.
        const storeIds = (
          await tx.select({ id: s.stores.id }).from(s.stores).where(eq(s.stores.orgId, orgId))
        ).map((r) => r.id);
        const stockKept = await applyPurge(tx, steps, ctx.session!.memberId);
        // CAT-5 (2026-10-30): the admin audit (domain.policy_decisions)
        // stays, as this procedure's contract says; it used to be wiped
        // with everything else. The purge itself is recorded in it.
        await auditAdmin(
          tx,
          ctx,
          'admin.purge.all',
          'org',
          orgId,
          { total, byTable: counts, storeIds, stockKept },
          { strict: true },
        );

        broadcastPurged(orgId, [], []);
        return { dryRun: false, total, byTable: counts, orgSlug: org.slug };
      });
    }),

  /**
   * Wipe one day's full order → run → delivery flow for this org: the
   * orders whose order_date and the runs whose run_date is $date, each
   * with the run or the orders it is linked to on other dates (CAT-4),
   * and their items, events, snapshots, outbox rows, notifications, price
   * history and run stock movements (datePurge in services/purgePlans.ts).
   * A date with a daily close is refused (CAT-2).
   *
   * Two passes over the same list: the first only counts rows, for the
   * dry-run preview; the second deletes. Wrapped in a single tx, so a
   * partial failure rolls back the whole thing.
   */
  purgeByDate: authedProcedure.input(PurgeByDateInputSchema).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.session!.permissions);
    requirePurgeRole(ctx.session!);
    // D1 (2026-10-30): off on production unless the server opts in.
    if (!bulkPurgeAllowed(env)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'admin.errors.bulkPurgeDisabledInProduction',
      });
    }
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const date = input.date;
      // CAT-2 (2026-10-30): a date with a daily close is refused, its
      // preview too.
      await refuseIfSettled(tx, orgId, date);

      // Resolve the affected stream id sets up-front. We use these
      // in both the count and the delete passes so the numbers are
      // self-consistent (no race between count and delete inside
      // the same tx).
      const sessionIds = executeRows<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM read_model.order_sessions_v
                WHERE org_id = ${orgId} AND order_date = ${date}`,
        ),
      ).map((r) => r.id);
      const runIds = executeRows<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM read_model.market_runs_v
                WHERE org_id = ${orgId} AND run_date = ${date}`,
        ),
      ).map((r) => r.id);

      // CAT-4 (2026-10-30): orders are picked by order_date and runs by
      // run_date, which differ when a run takes earlier orders. Deleting
      // one side left the other pointing at nothing, and those orphans
      // could not be deleted afterwards. An order and its run go together.
      const ownSessions = new Set(sessionIds);
      const ownRuns = new Set(runIds);
      await closeOverRunLinks(tx, orgId, sessionIds, runIds);
      // DX-CAT-5 (2026-11-01): the preview says what is this day's and
      // what goes with it from other dates (an order of 11-01 on a run of
      // 10-30, or the 10-31 run holding today's orders), with the dates.
      // Only the totals were shown, under a title naming the one date.
      const scope = await purgeDateScope(
        tx,
        orgId,
        sessionIds.filter((id) => !ownSessions.has(id)),
        runIds.filter((id) => !ownRuns.has(id)),
        { orders: ownSessions.size, runs: ownRuns.size },
      );

      // ADM2-04: the preview counts and the purge deletes the same list.
      const steps = datePurge(orgId, sessionIds, runIds);
      const counts = await countPurge(tx, steps);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);

      if (input.dryRun) {
        return { dryRun: true, total, byTable: counts, date, scope };
      }

      const storeIds = await storesOfSessions(tx, orgId, sessionIds);
      const stockKept = await applyPurge(tx, steps, ctx.session!.memberId);

      await auditAdmin(
        tx,
        ctx,
        'admin.purge.date',
        'org',
        orgId,
        { date, total, byTable: counts, sessionIds, runIds, storeIds, stockKept },
        { strict: true },
      );
      broadcastPurged(orgId, sessionIds, runIds);
      return { dryRun: false, total, byTable: counts, date, scope };
    });
  }),

  // ============ TARGETED PURGE: list + per-session + per-run ============

  /**
   * List recent order sessions the admin can choose to delete. Powers
   * the "pick one to nuke" UI in Maintenance. Includes ALL statuses so
   * an admin can purge in_run / archived sessions via the run path.
   */
  sessionList: authedProcedure
    .input(
      z
        .object({
          date: DateStringSchema.optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const date = input?.date;
        const limit = input?.limit ?? 50;
        const sessionScope = await getAdminReadScope(tx, ctx.session!);
        const rows = await tx
          .select({
            id: s.orderSessionsV.id,
            storeId: s.orderSessionsV.storeId,
            initiatedByMemberId: s.orderSessionsV.initiatedByMemberId,
            submittedByMemberId: s.orderSessionsV.submittedByMemberId,
            orderDate: s.orderSessionsV.orderDate,
            status: s.orderSessionsV.status,
            runId: s.orderSessionsV.runId,
            updatedAt: s.orderSessionsV.updatedAt,
          })
          .from(s.orderSessionsV)
          .where(
            and(
              eq(s.orderSessionsV.orgId, orgId),
              date ? eq(s.orderSessionsV.orderDate, date) : undefined,
              // HIS-3 (2026-10-30): a store-tier admin sees their stores'
              // orders only, like every other admin read.
              sessionScope === null
                ? undefined
                : sessionScope.size === 0
                  ? sql`false`
                  : inArray(s.orderSessionsV.storeId, [...sessionScope]),
            ),
          )
          .orderBy(desc(s.orderSessionsV.updatedAt))
          .limit(limit);
        if (rows.length === 0) return [];
        const storeIds = [...new Set(rows.map((r) => r.storeId))];
        // Attribution: prefer submitter, fall back to initiator.
        const memberIds = [
          ...new Set(
            rows
              .map((r) => r.submittedByMemberId ?? r.initiatedByMemberId)
              .filter(Boolean) as string[],
          ),
        ];
        const [stores, memberJoins, contributors] = await Promise.all([
          tx.query.stores.findMany({
            where: (st, { inArray: ia }) => ia(st.id, storeIds),
          }),
          memberIds.length
            ? tx
                .select({
                  memberId: s.members.id,
                  userId: s.members.userId,
                  displayName: s.users.displayName,
                  tgUsername: s.users.tgUsername,
                })
                .from(s.members)
                .innerJoin(s.users, eq(s.users.id, s.members.userId))
                .where(inArray(s.members.id, memberIds))
            : Promise.resolve(
                [] as Array<{
                  memberId: string;
                  userId: string;
                  displayName: string;
                  tgUsername: string | null;
                }>,
              ),
          // All raw rows for these sessions (we'll filter empty ones out).
          tx
            .select({
              sessionId: s.orderItemsV.sessionId,
              skuId: s.orderItemsV.skuId,
              contributorMemberId: s.orderItemsV.contributorMemberId,
              qty: s.orderItemsV.qty,
            })
            .from(s.orderItemsV)
            .where(
              inArray(
                s.orderItemsV.sessionId,
                rows.map((r) => r.id),
              ),
            ),
        ]);
        const storeById = new Map(stores.map((st) => [st.id, st]));
        const memberById = new Map(memberJoins.map((m) => [m.memberId, m]));
        const callerMemberId = ctx.session!.memberId;

        // DX-CAT-3 (2026-11-01): say on each row whether it can be deleted
        // here and why not. The list offered a red Delete on every order
        // that was not in a run, and the refusal only came after a tap.
        // ADM2-08: the rule purgeSession applies (services/purgeGuards.ts).
        const deleteBlocks = await sessionDeleteBlocks(tx, ctx.session!, rows, {
          requireOnlyTestSessions: true,
        });

        // Per-session: aggregate qty across contributors per SKU, in exact
        // thousandths (review ADM2-30: these were float sums).
        const skuTotalsBySession = new Map<string, Map<string, bigint>>();
        const sessionsWhereImAuthor = new Set<string>();
        for (const c of contributors) {
          const v = qtyMilliOrZero(c.qty);
          const m = skuTotalsBySession.get(c.sessionId) ?? new Map<string, bigint>();
          if (v > 0n) {
            m.set(c.skuId, (m.get(c.skuId) ?? 0n) + v);
            if (c.contributorMemberId === callerMemberId) {
              sessionsWhereImAuthor.add(c.sessionId);
            }
          }
          skuTotalsBySession.set(c.sessionId, m);
        }
        const aggregateBySession = new Map<string, { itemCount: number; totalMilli: bigint }>();
        for (const [sessionId, skuTotals] of skuTotalsBySession) {
          let count = 0;
          let total = 0n;
          for (const v of skuTotals.values()) {
            if (v > 0n) {
              count += 1;
              total += v;
            }
          }
          aggregateBySession.set(sessionId, { itemCount: count, totalMilli: total });
        }

        return (
          rows
            .map((r) => {
              const attribMemberId = r.submittedByMemberId ?? r.initiatedByMemberId;
              const m = attribMemberId ? memberById.get(attribMemberId) : null;
              const agg = aggregateBySession.get(r.id) ?? { itemCount: 0, totalMilli: 0n };
              return {
                sessionId: r.id,
                storeId: r.storeId,
                storeName: storeById.get(r.storeId)?.name ?? null,
                attribMemberId: attribMemberId ?? null,
                attribDisplayName: m?.displayName ?? null,
                attribTgUsername: m?.tgUsername ?? null,
                isMine:
                  sessionsWhereImAuthor.has(r.id) ||
                  (attribMemberId !== null && attribMemberId === callerMemberId),
                orderDate: r.orderDate,
                status: r.status,
                runId: r.runId,
                itemCount: agg.itemCount,
                /**
                 * @deprecated Kilos, litres and pieces added together (walkthrough
                 * F14): no screen here reads it. Kept, exact, for other clients
                 * until they are checked (review ADM2-30).
                 */
                totalQty: milliQty(agg.totalMilli),
                updatedAt: r.updatedAt.toISOString(),
                deleteBlock: deleteBlocks.get(r.id) ?? null,
              };
            })
            // #4: an "empty" session (every contributor's qty is 0) shouldn't
            // clutter the maintenance browser. Only show sessions that have
            // at least one SKU with non-zero aggregate qty, OR whose status
            // moved past draft (e.g. submitted-and-then-everything-cleared
            // is still meaningful for audit).
            .filter((r) => r.itemCount > 0 || r.status !== 'draft')
        );
      });
    }),

  /**
   * List recent market runs the admin can choose to delete.
   */
  runList: authedProcedure
    .input(
      z
        .object({
          date: DateStringSchema.optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const date = input?.date;
        const limit = input?.limit ?? 50;
        const runScope = await getAdminReadScope(tx, ctx.session!);
        const rows = await tx
          .select({
            id: s.marketRunsV.id,
            runDate: s.marketRunsV.runDate,
            runIndex: s.marketRunsV.runIndex,
            status: s.marketRunsV.status,
            purchaserMemberId: s.marketRunsV.purchaserMemberId,
            sessionIdsJson: s.marketRunsV.sessionIdsJson,
            updatedAt: s.marketRunsV.updatedAt,
          })
          .from(s.marketRunsV)
          .where(
            and(
              eq(s.marketRunsV.orgId, orgId),
              date ? eq(s.marketRunsV.runDate, date) : undefined,
              // HIS-3: only runs that touch the admin's stores.
              runScope === null
                ? undefined
                : runTouchesStores(sql`${s.marketRunsV.id}`, [...runScope]),
            ),
          )
          .orderBy(desc(s.marketRunsV.updatedAt))
          .limit(limit);
        if (rows.length === 0) return [];
        const memberIds = [
          ...new Set(rows.map((r) => r.purchaserMemberId).filter(Boolean) as string[]),
        ];
        const memberJoins = memberIds.length
          ? await tx
              .select({
                memberId: s.members.id,
                userId: s.members.userId,
                displayName: s.users.displayName,
              })
              .from(s.members)
              .innerJoin(s.users, eq(s.users.id, s.members.userId))
              .where(inArray(s.members.id, memberIds))
          : [];
        const memberById = new Map(memberJoins.map((m) => [m.memberId, m]));
        // DX-CAT-3 (2026-11-01): why each run can't be deleted here, by
        // the rule purgeRun applies (ADM2-08).
        const deleteBlocks = await runDeleteBlocks(
          tx,
          ctx.session!,
          rows.map((r) => ({ id: r.id, sessionIds: r.sessionIdsJson })),
          { requireOnlyTestSessions: true },
        );
        return rows.map((r) => {
          const sessionIds = r.sessionIdsJson;
          const m = r.purchaserMemberId ? memberById.get(r.purchaserMemberId) : null;
          return {
            deleteBlock: deleteBlocks.get(r.id) ?? null,
            runId: r.id,
            runDate: r.runDate,
            runIndex: r.runIndex,
            status: r.status,
            sessionCount: sessionIds.length,
            purchaserDisplayName: m?.displayName ?? null,
            purchaserIsMe: m?.userId === ctx.session!.userId,
            updatedAt: r.updatedAt.toISOString(),
          };
        });
      });
    }),

  /**
   * Submission history feed: per-store timeline of every order that has
   * been submitted, with status outcome + approval delay + per-SKU
   * totals + per-contributor breakdown. Read-only — pure audit/insight
   * surface for managers and admins. Filtered to the caller's org via
   * RLS; the date range defaults to the last 30 days.
   */
  submissionHistory: authedProcedure
    .input(
      z
        .object({
          storeId: UuidSchema.optional(),
          fromDate: DateStringSchema.optional(),
          toDate: DateStringSchema.optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const limit = input?.limit ?? 50;
        // D.1 (M3.39, 2026-05-20): default date range is "today and the
        // previous 30 days", both expressed in the ORG's timezone. The
        // previous UTC-based default could put `toDate` one day behind
        // the user's local calendar for any UZ-tenant request between
        // 00:00 and 05:00 UTC.
        const tz = ctx.session!.orgTimezone;
        const fromDate =
          input?.fromDate ?? dateInTz(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), tz);
        const toDate = input?.toDate ?? todayInTz(tz);

        // HIS-2 (2026-10-30): any store manager saw the whole org's
        // submissions, submitters, deciders and reject reasons. Limit to
        // the admin's stores; naming a store outside them is refused.
        const historyScope = await getAdminReadScope(tx, ctx.session!);
        if (historyScope !== null && input?.storeId && !historyScope.has(input.storeId)) {
          // Review ADM2-31 (2026-11-12): the admin refusal. It said "you are
          // not assigned to this store", which is not why: the scope holds
          // the stores they administer, paused and archived ones included.
          throw new TRPCError({ code: 'FORBIDDEN', message: 'admin.errors.notAdminOfStore' });
        }
        const historyStoreFilter =
          historyScope === null
            ? sql``
            : historyScope.size === 0
              ? sql`AND false`
              : sql`AND store_id IN (${sql.join(
                  [...historyScope].map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})`;

        // Only sessions that progressed past draft are "submissions".
        // We use a raw query so we can express the date range + status
        // filter cleanly without drizzle hoops.
        const rawSessions = executeRows<{
          id: string;
          store_id: string;
          order_date: string;
          status: string;
          submitted_at: Date | null;
          decided_at: Date | null;
          submitted_by_member_id: string | null;
          decided_by_member_id: string | null;
          reject_reason: string | null;
          run_id: string | null;
        }>(
          await tx.execute(
            sql`SELECT id, store_id, order_date, status, submitted_at, decided_at,
                       submitted_by_member_id, decided_by_member_id, reject_reason, run_id
                FROM read_model.order_sessions_v
                WHERE org_id = ${orgId}
                  AND status IN ('submitted','approved','rejected','in_run','archived')
                  AND order_date >= ${fromDate}
                  AND order_date <= ${toDate}
                  ${input?.storeId ? sql`AND store_id = ${input.storeId}` : sql``}
                  ${historyStoreFilter}
                ORDER BY submitted_at DESC NULLS LAST
                LIMIT ${limit}`,
          ),
        );
        if (rawSessions.length === 0) return [];

        const sessionIds = rawSessions.map((r) => r.id);
        const storeIds = [...new Set(rawSessions.map((r) => r.store_id))];
        const memberIds = [
          ...new Set(
            [
              ...rawSessions.map((r) => r.submitted_by_member_id),
              ...rawSessions.map((r) => r.decided_by_member_id),
            ].filter(Boolean) as string[],
          ),
        ];

        const [items, stores, members] = await Promise.all([
          tx.query.orderItemsV.findMany({
            where: (it, { inArray: ia }) => ia(it.sessionId, sessionIds),
          }),
          tx.query.stores.findMany({
            where: (st, { inArray: ia }) => ia(st.id, storeIds),
          }),
          memberIds.length
            ? tx
                .select({
                  memberId: s.members.id,
                  displayName: s.users.displayName,
                })
                .from(s.members)
                .innerJoin(s.users, eq(s.users.id, s.members.userId))
                .where(inArray(s.members.id, memberIds))
            : Promise.resolve([] as Array<{ memberId: string; displayName: string }>),
        ]);
        const storeById = new Map(stores.map((st) => [st.id, st]));
        const memberById = new Map(members.map((m) => [m.memberId, m.displayName]));

        // Per-session: contributor → SKUs[] → qty, in exact thousandths
        // (review ADM2-30: these were float sums).
        const skuTotalsBySession = new Map<string, Map<string, bigint>>();
        const contributorsBySession = new Map<
          string,
          Map<string, Array<{ skuId: string; milli: bigint }>>
        >();
        for (const it of items) {
          const v = qtyMilliOrZero(it.qty);
          if (v <= 0n) continue;
          const tot = skuTotalsBySession.get(it.sessionId) ?? new Map<string, bigint>();
          tot.set(it.skuId, (tot.get(it.skuId) ?? 0n) + v);
          skuTotalsBySession.set(it.sessionId, tot);
          const cmap =
            contributorsBySession.get(it.sessionId) ??
            new Map<string, Array<{ skuId: string; milli: bigint }>>();
          const arr = cmap.get(it.contributorMemberId) ?? [];
          arr.push({ skuId: it.skuId, milli: v });
          cmap.set(it.contributorMemberId, arr);
          contributorsBySession.set(it.sessionId, cmap);
        }
        /**
         * @deprecated the `totalQty` fields below add kilos, litres and pieces
         * together (walkthrough F14); no screen here reads them. Kept, exact,
         * for other clients until they are checked (review ADM2-30).
         */
        const crossUnitTotal = (milli: Iterable<bigint>): number => {
          let sum = 0n;
          for (const m of milli) sum += m;
          return Number(milliQty(sum));
        };

        return rawSessions.map((sess) => {
          const totals = skuTotalsBySession.get(sess.id) ?? new Map<string, bigint>();
          const contribs =
            contributorsBySession.get(sess.id) ??
            new Map<string, Array<{ skuId: string; milli: bigint }>>();
          const submittedAt = sess.submitted_at ? new Date(sess.submitted_at) : null;
          const decidedAt = sess.decided_at ? new Date(sess.decided_at) : null;
          const reviewMinutes =
            submittedAt && decidedAt
              ? Math.round((decidedAt.getTime() - submittedAt.getTime()) / 60000)
              : null;
          return {
            sessionId: sess.id,
            storeId: sess.store_id,
            storeName: storeById.get(sess.store_id)?.name ?? null,
            orderDate: sess.order_date,
            status: sess.status,
            submittedAt: submittedAt?.toISOString() ?? null,
            submittedByMemberId: sess.submitted_by_member_id,
            submittedByName: sess.submitted_by_member_id
              ? (memberById.get(sess.submitted_by_member_id) ?? null)
              : null,
            decidedAt: decidedAt?.toISOString() ?? null,
            decidedByMemberId: sess.decided_by_member_id,
            decidedByName: sess.decided_by_member_id
              ? (memberById.get(sess.decided_by_member_id) ?? null)
              : null,
            rejectReason: sess.reject_reason,
            runId: sess.run_id,
            reviewMinutes,
            skuCount: totals.size,
            totalQty: crossUnitTotal(totals.values()),
            contributors: [...contribs.entries()].map(([memberId, lines]) => ({
              memberId,
              displayName: memberById.get(memberId) ?? null,
              skuCount: lines.length,
              totalQty: crossUnitTotal(lines.map((l) => l.milli)),
            })),
          };
        });
      });
    }),

  /** Surgical single-session purge. See PurgeSessionInputSchema doc. */
  purgeSession: authedProcedure.input(PurgeSessionInputSchema).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.session!.permissions);
    requirePurgeRole(ctx.session!);
    refuseGuardWaiverInProduction(input.requireOnlyTestSessions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const session = await tx.query.orderSessionsV.findFirst({
        where: (sess, { eq: eq2, and: and2 }) =>
          and2(eq2(sess.id, input.sessionId), eq2(sess.orgId, orgId)),
      });
      if (!session) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.sessionNotFound' });
      }
      // Refuse an order in a run, someone else's, or one someone else
      // acted on. The maintenance list shows the same reason on its row
      // (ADM2-08).
      const block = (
        await sessionDeleteBlocks(tx, ctx.session!, [session], {
          requireOnlyTestSessions: input.requireOnlyTestSessions,
        })
      ).get(session.id);
      if (block) throw sessionDeleteRefusal(block);

      // ADM2-04: the preview counts and the purge deletes the same list.
      const steps = sessionPurge(orgId, input.sessionId);
      const counts = await countPurge(tx, steps);
      if (input.dryRun) {
        return {
          dryRun: true,
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          byTable: counts,
          sessionId: input.sessionId,
        };
      }
      await applyPurge(tx, steps, ctx.session!.memberId);
      // ADM2-05 (2026-11-09): what went, while it can still be read — the
      // store (which also shows the row to that store's admins), the day,
      // the status and whose order it was. Ids alone named nothing once
      // the rows were gone.
      await auditAdmin(
        tx,
        ctx,
        'admin.purge.session',
        'session',
        input.sessionId,
        {
          ...input,
          byTable: counts,
          storeId: session.storeId,
          orderDate: session.orderDate,
          status: session.status,
          memberId: session.initiatedByMemberId ?? session.submittedByMemberId,
        },
        { strict: true },
      );
      broadcastPurged(orgId, [input.sessionId], []);
      return {
        dryRun: false,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        byTable: counts,
        sessionId: input.sessionId,
      };
    });
  }),

  /** Whole-run purge. See PurgeRunInputSchema doc. */
  purgeRun: authedProcedure.input(PurgeRunInputSchema).mutation(async ({ ctx, input }) => {
    requireAdmin(ctx.session!.permissions);
    requirePurgeRole(ctx.session!);
    refuseGuardWaiverInProduction(input.requireOnlyTestSessions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const run = await tx.query.marketRunsV.findFirst({
        where: (r, { eq: eq2, and: and2 }) => and2(eq2(r.id, input.runId), eq2(r.orgId, orgId)),
      });
      if (!run) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.runNotFound' });
      }
      const sessionIds = run.sessionIdsJson;

      // Refuse a run with someone else's orders in it, or one that
      // someone else acted on (or on its orders). The maintenance list
      // shows the same reason on its row (ADM2-08).
      const block = (
        await runDeleteBlocks(tx, ctx.session!, [{ id: run.id, sessionIds }], {
          requireOnlyTestSessions: input.requireOnlyTestSessions,
        })
      ).get(run.id);
      if (block) throw runDeleteRefusal(block);

      // ADM2-04: the preview counts and the purge deletes the same list.
      const steps = runPurge(orgId, input.runId, sessionIds);
      const counts = await countPurge(tx, steps);
      if (input.dryRun) {
        return {
          dryRun: true,
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          byTable: counts,
          runId: input.runId,
          sessionIds,
        };
      }
      // ADM2-05 (2026-11-09): the run's day and number, its purchaser and
      // the stores whose orders it held, read before they are deleted.
      const storeIds = await storesOfSessions(tx, orgId, sessionIds);
      const stockKept = await applyPurge(tx, steps, ctx.session!.memberId);
      await auditAdmin(
        tx,
        ctx,
        'admin.purge.run',
        'run',
        input.runId,
        {
          ...input,
          sessionIds,
          byTable: counts,
          runDate: run.runDate,
          runIndex: run.runIndex,
          status: run.status,
          storeIds,
          memberId: run.purchaserMemberId,
          stockKept,
        },
        { strict: true },
      );
      broadcastPurged(orgId, sessionIds, [input.runId]);
      return {
        dryRun: false,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        byTable: counts,
        runId: input.runId,
        sessionIds,
      };
    });
  }),
};
