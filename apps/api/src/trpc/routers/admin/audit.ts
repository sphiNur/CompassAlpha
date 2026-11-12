/** What happened: the latest domain events and the admin audit list. */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { UuidSchema } from '@compass/contracts';
import { authedProcedure } from '../../trpc';
import { priceStoreIds, withoutPrices } from '../../../services/priceRedaction';
import { recentEventContext } from '../../../services/eventContext';
import { requireAdmin } from './guards';
import { getAdminReadScope, runTouchesStores } from './scope';
import {
  auditTouchesStores,
  auditRowRefs,
  auditLabelsAtWrite,
  buildAuditLabels,
  loadAuditLookups,
} from '../../../services/adminAudit';

export const auditProcedures = {
  // ============ AUDIT (recent domain events) ============

  /** Last N events across the org's order + run streams. Read-only feed
   *  for admins to see what's been happening. */
  recentEvents: authedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const limit = input?.limit ?? 50;
        // 2026-10-21 CA-17: events carry no store id, so a non-org-admin
        // is filtered through the read models: order streams of their
        // stores, and run streams that involve one of their stores. A
        // shared run's events can still mention other stores' lines —
        // accepted: the manager already sees that run on the Run page.
        const scope = await getAdminReadScope(tx, ctx.session!);
        let scopeFilter: ReturnType<typeof sql> | null = null;
        if (scope) {
          if (scope.size === 0) return [];
          const ids = sql.join(
            [...scope].map((id) => sql`${id}::uuid`),
            sql`, `,
          );
          scopeFilter = sql`((${s.events.streamType} = 'order' AND ${s.events.streamId} IN (SELECT os.id FROM read_model.order_sessions_v os WHERE os.store_id IN (${ids}))) OR (${s.events.streamType} = 'run' AND ${runTouchesStores(sql`${s.events.streamId}`, [...scope])}))`;
        }
        const rows = await tx
          .select({
            id: s.events.id,
            streamId: s.events.streamId,
            streamType: s.events.streamType,
            seq: s.events.seq,
            type: s.events.type,
            actorId: s.events.actorId,
            occurredAt: s.events.occurredAt,
            payload: s.events.payload,
          })
          .from(s.events)
          .where(and(eq(s.events.orgId, orgId), ...(scopeFilter ? [scopeFilter] : [])))
          // DX-CAT-2 (2026-11-01): events of one command share occurredAt;
          // without a tie-break they came back as seq 15, 13, 14.
          .orderBy(desc(s.events.occurredAt), desc(s.events.seq), desc(s.events.id))
          .limit(limit);
        if (rows.length === 0) return [];
        const context = await recentEventContext(tx, orgId, rows);
        const userIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean) as string[])];
        const users = userIds.length
          ? await tx
              .select({
                id: s.users.id,
                displayName: s.users.displayName,
                tgUsername: s.users.tgUsername,
              })
              .from(s.users)
              .where(inArray(s.users.id, userIds))
          : [];
        const userById = new Map(users.map((u) => [u.id, u]));
        // Review ADM2-01 (2026-11-09): run payloads carry unit prices and
        // expense amounts. They are returned as stored only to a reader
        // who may price every store; anyone else gets them nulled, as on
        // the run page. (The feed itself shows none of them.)
        const showMoney = (await priceStoreIds(tx, ctx.session!)) === null;
        return rows.map((r) => ({
          id: r.id,
          streamId: r.streamId,
          streamType: r.streamType,
          seq: r.seq,
          type: r.type,
          actor: r.actorId ? (userById.get(r.actorId) ?? null) : null,
          occurredAt: r.occurredAt.toISOString(),
          payload: showMoney ? (r.payload as unknown) : withoutPrices(r.payload as unknown),
          context: context.get(r.id) ?? null,
        }));
      });
    }),

  /**
   * Recent ADMIN actions — distinct from `recentEvents`, which is the
   * order/run domain stream. This pulls from `domain.policy_decisions`
   * (one row per `auditAdmin()` call) so an admin can answer:
   *   - Who renamed this SKU last week?
   *   - Who promoted Ali to manager?
   *   - When did Aziz get the order.approve override?
   *
   * The actions cover the catalog, stores, roles, members with their
   * permissions and invites, purges, catalog imports and the workspace's
   * finance settings. Review ADM2-40 (2026-11-12): the list kept here
   * named six objects and missed the rest; the auditAdmin calls are the
   * list.
   *
   * 50 rows by default; up to 200 for deeper digs.
   */
  adminAuditList: authedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).default(50),
          /** B2 (2026-05-06): filter by store. When set, only rows
           *  whose `scope_store_id` matches are returned. Pre-2026-05-06
           *  rows have NULL scope and are excluded — that's intentional;
           *  the filter answers "what changed in Store X recently". */
          storeId: UuidSchema.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const limit = input?.limit ?? 50;
        const storeId = input?.storeId;
        // 2026-10-21 CA-17: a non-org-admin sees only rows whose
        // scope_store_id is one of the stores they administer. Org-wide
        // rows (catalog, roles, finance; NULL scope) stay with org admins.
        const scope = await getAdminReadScope(tx, ctx.session!);
        if (scope && (scope.size === 0 || (storeId && !scope.has(storeId)))) return [];
        const rows = await tx
          .select({
            id: s.policyDecisions.id,
            action: s.policyDecisions.action,
            resourceType: s.policyDecisions.resourceType,
            resourceId: s.policyDecisions.resourceId,
            actorId: s.policyDecisions.actorId,
            occurredAt: s.policyDecisions.occurredAt,
            inputs: s.policyDecisions.inputs,
            scopeStoreId: s.policyDecisions.scopeStoreId,
          })
          .from(s.policyDecisions)
          .where(
            and(
              eq(s.policyDecisions.orgId, orgId),
              // 2026-10-21: a transfer touches two stores but has one
              // scope column (the destination); also match its from-side
              // so the source store's admins see who left.
              ...(storeId ? [auditTouchesStores([storeId])] : []),
              ...(scope && !storeId ? [auditTouchesStores([...scope])] : []),
            ),
          )
          .orderBy(desc(s.policyDecisions.occurredAt))
          .limit(limit);
        if (rows.length === 0) return [];
        const userIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean) as string[])];
        const users = userIds.length
          ? await tx
              .select({
                id: s.users.id,
                displayName: s.users.displayName,
                tgUsername: s.users.tgUsername,
              })
              .from(s.users)
              .where(inArray(s.users.id, userIds))
          : [];
        const userById = new Map(users.map((u) => [u.id, u]));
        // 2026-10-21 FE-08: readable target / role / store names per row.
        const refs = rows.map((r) => auditRowRefs(r));
        const lookups = await loadAuditLookups(tx, orgId, refs);
        return rows.map((r, i) => ({
          id: r.id,
          action: r.action,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          actor: r.actorId ? (userById.get(r.actorId) ?? null) : null,
          /** No person acted: `compass user grant` writes its rows
           *  without an actor. A missing user is not this. */
          bySystem: r.actorId === null,
          occurredAt: r.occurredAt.toISOString(),
          inputs: r.inputs as unknown,
          scopeStoreId: r.scopeStoreId,
          labels: buildAuditLabels(refs[i]!, lookups, auditLabelsAtWrite(r.inputs)),
        }));
      });
    }),
};
