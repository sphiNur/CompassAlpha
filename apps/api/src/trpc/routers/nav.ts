/**
 * Bottom-nav badges (DX-SHL-23 / DX-APR-5 / DX-DLV-13 / DX-CLS, 2026-11-01).
 *
 * Requirement 03 §2.4: the nav says where something waits for this person —
 * orders to review, orders to buy, goods to receive, today's close not
 * filed. One small query for the whole bar instead of each page's own list
 * (those carry estimates, members and money the badge does not need).
 *
 * Every count follows the same permission the page behind the tab checks,
 * resolved per store (roles plus allow / deny overrides). A count the
 * caller may not see is `null`, so the client draws no badge rather than a
 * misleading 0.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { todayInTz } from '@compass/domain';
import { authedProcedure, router } from '../trpc';
import {
  effectivePermissionsForStore,
  getActorStoreIds,
  getActorStoreIdsForPermission,
} from '../../services/storeScope';
import { storeTimeZone } from '../../services/timeZone';
import { resolveRunCreateStoreScope } from './run';

const NavCountsInputSchema = z.object({
  /** The store chosen in the header; omitted for 「全部门店」. */
  storeId: z.string().uuid().optional(),
});

/** No store can have this id; keeps `inArray` from meeting an empty list. */
const NO_STORE = '00000000-0000-0000-0000-000000000000';

export const navRouter = router({
  counts: authedProcedure.input(NavCountsInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const session = ctx.session!;
      const orgId = session.orgId;
      const result: {
        approve: number | null;
        run: number | null;
        confirm: number | null;
        settlementDue: boolean | null;
      } = { approve: null, run: null, confirm: null, settlementDue: null };

      // The store in the header, only when the caller is assigned to it.
      let storePerms: ReadonlySet<string> | null = null;
      if (input.storeId) {
        const assigned = await getActorStoreIds(tx, session.memberId, session.permissions);
        if (assigned === null || assigned.includes(input.storeId)) {
          storePerms = await effectivePermissionsForStore(
            tx,
            session.memberId,
            input.storeId,
            session.permissions,
          );
        }
      }

      // 审核: submitted orders, minus the ones another reviewer holds.
      // Same scope as order.pendingList (order.approve or order.claim).
      if (session.permissions.has('order.approve') || session.permissions.has('order.claim')) {
        let storeIds: string[] | null;
        if (input.storeId) {
          storeIds =
            storePerms && (storePerms.has('order.approve') || storePerms.has('order.claim'))
              ? [input.storeId]
              : [];
        } else {
          const [approve, claim] = await Promise.all([
            getActorStoreIdsForPermission(tx, session.memberId, 'order.approve', session.permissions),
            getActorStoreIdsForPermission(tx, session.memberId, 'order.claim', session.permissions),
          ]);
          storeIds = approve === null || claim === null ? null : [...new Set([...approve, ...claim])];
        }
        if (storeIds === null || storeIds.length > 0) {
          const [row] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(s.orderSessionsV)
            .where(
              and(
                eq(s.orderSessionsV.orgId, orgId),
                eq(s.orderSessionsV.status, 'submitted'),
                storeIds === null ? undefined : inArray(s.orderSessionsV.storeId, storeIds),
                or(
                  isNull(s.orderSessionsV.claimedByMemberId),
                  eq(s.orderSessionsV.claimedByMemberId, session.memberId),
                ),
              ),
            );
          result.approve = row?.n ?? 0;
        } else {
          result.approve = 0;
        }
      }

      // 采购: approved orders not on a purchase run yet — what the Run tab
      // offers to start a run with (run.previewCreatable's scope). The tab
      // is cross-store, so this ignores the header store.
      if (session.permissions.has('run.purchase')) {
        const storeIds = await resolveRunCreateStoreScope(tx, ctx);
        const [row] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(s.orderSessionsV)
          .where(
            and(
              eq(s.orderSessionsV.orgId, orgId),
              eq(s.orderSessionsV.status, 'approved'),
              storeIds === null
                ? undefined
                : inArray(s.orderSessionsV.storeId, storeIds.length > 0 ? storeIds : [NO_STORE]),
            ),
          );
        result.run = row?.n ?? 0;
      }

      if (!input.storeId || !storePerms) return result;

      // 验收: delivering runs that handed goods to this store and wait
      // for its signature (what the Confirm page lists).
      if (storePerms.has('delivery.confirm')) {
        const [row] = await tx
          .select({ n: sql<number>`count(distinct ${s.runItemStoresV.runId})::int` })
          .from(s.runItemStoresV)
          .innerJoin(s.marketRunsV, eq(s.marketRunsV.id, s.runItemStoresV.runId))
          .where(
            and(
              eq(s.marketRunsV.orgId, orgId),
              eq(s.marketRunsV.status, 'delivering'),
              eq(s.runItemStoresV.storeId, input.storeId),
              isNotNull(s.runItemStoresV.deliveredAt),
              isNull(s.runItemStoresV.confirmedAt),
            ),
          );
        result.confirm = row?.n ?? 0;
      }

      // 日结: no close filed yet for the store's business today.
      if (storePerms.has('settlement.record')) {
        const store = await tx.query.stores.findFirst({
          where: (st, { and: and2, eq: eq2 }) => and2(eq2(st.id, input.storeId!), eq2(st.orgId, orgId)),
          columns: { id: true, timezone: true, isActive: true, deletedAt: true },
        });
        if (store && store.isActive && !store.deletedAt) {
          const today = todayInTz(storeTimeZone(store.timezone, session.orgTimezone));
          const filed = await tx.query.storeDailySettlements.findFirst({
            where: (row, { and: and2, eq: eq2 }) =>
              and2(
                eq2(row.orgId, orgId),
                eq2(row.storeId, store.id),
                eq2(row.settlementDate, today),
              ),
            columns: { id: true },
          });
          result.settlementDue = !filed;
        }
      }

      return result;
    });
  }),
});
