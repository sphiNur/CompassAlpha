/** The organisation's overview and its finance settings. */
import { TRPCError } from '@trpc/server';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { TAX_RATE_MESSAGE, TAX_RATE_RE, taxRateProblem } from '@compass/contracts/limits';
import { authedProcedure } from '../../trpc';
import { requireAdmin, requireOrgAdmin } from './guards';
import { getAdminReadScope, visibleMemberIds, runTouchesStores } from './scope';
import { auditAdmin } from '../../../services/adminAudit';

export const overviewProcedures = {
  /** Org-level dashboard summary. */
  overview: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // 2026-10-21 CA-17: a store manager's dashboard counts only their
      // stores (members, stores, runs, orders). The SKU catalog is
      // org-wide and shared, so its count is not scoped.
      const scope = await getAdminReadScope(tx, ctx.session!);
      const scopeIds = scope ? [...scope] : null;
      const memberIds = scope
        ? [...(await visibleMemberIds(tx, scope, ctx.session!.memberId))]
        : null;
      const [memberCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.members)
        .where(
          and(eq(s.members.orgId, orgId), ...(memberIds ? [inArray(s.members.id, memberIds)] : [])),
        );
      const [storeCount] = scopeIds
        ? [{ n: scopeIds.length }]
        : await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(s.stores)
            .where(eq(s.stores.orgId, orgId));
      const [skuCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.skus)
        .where(and(eq(s.skus.orgId, orgId), eq(s.skus.isArchived, false)));
      const sessionInScope =
        scopeIds === null
          ? []
          : scopeIds.length > 0
            ? [inArray(s.orderSessionsV.storeId, scopeIds)]
            : [sql`false`];
      const [runCount] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.marketRunsV)
        .where(
          and(
            eq(s.marketRunsV.orgId, orgId),
            ...(scopeIds === null ? [] : [runTouchesStores(sql`${s.marketRunsV.id}`, scopeIds)]),
          ),
        );
      const [pendingApprovals] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.orderSessionsV)
        .where(
          and(
            eq(s.orderSessionsV.orgId, orgId),
            eq(s.orderSessionsV.status, 'submitted'),
            ...sessionInScope,
          ),
        );
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [ordersThisWeek] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(s.orderSessionsV)
        .where(
          and(
            eq(s.orderSessionsV.orgId, orgId),
            gte(s.orderSessionsV.updatedAt, sevenDaysAgo),
            ...sessionInScope,
          ),
        );
      return {
        memberCount: memberCount?.n ?? 0,
        storeCount: storeCount?.n ?? 0,
        skuCount: skuCount?.n ?? 0,
        runCount: runCount?.n ?? 0,
        pendingApprovals: pendingApprovals?.n ?? 0,
        ordersThisWeek: ordersThisWeek?.n ?? 0,
      };
    });
  }),

  // ============ ORG FINANCIAL SETTINGS (M1.17) ============
  //
  // Read-only `overview` already returns the org name + ID. M1.17
  // adds an editor for the financial trio (currency, tax rate,
  // prices_include_tax). Gated on users.manage — these are
  // organization-wide policy levers that should never be touched by
  // a store manager unilaterally. Effect:
  //
  //   - Mutating `currency` does NOT re-denominate historical money
  //     columns. It only shifts the suffix the FE renders going
  //     forward. Operators MUST treat this as set-once per org.
  //   - Mutating `taxRatePct` is a forward-only display change for
  //     reports; per-transaction tax capture (M2.x) will snapshot the
  //     rate at purchase time, so historical edits won't retroactively
  //     rewrite past calculations.
  //   - Mutating `pricesIncludeTax` flips how reports interpret stored
  //     unit prices. Operators should align this with how their
  //     suppliers actually quote (most market stalls quote gross).
  // M3.3: org finance settings are org-wide; only org.admin can edit.
  orgFinanceUpdate: authedProcedure
    .input(
      z.object({
        currency: z
          .string()
          .length(3)
          .regex(/^[A-Z]{3}$/, 'currency must be ISO-4217 (3 uppercase letters)'),
        taxRatePct: z.string().regex(TAX_RATE_RE, TAX_RATE_MESSAGE.format),
        pricesIncludeTax: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      // Runaway rates are refused (TAX_RATE_MAX_PCT); the finance sheet
      // asks the same function before Save.
      const taxProblem = taxRateProblem(input.taxRatePct);
      if (taxProblem) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: TAX_RATE_MESSAGE[taxProblem] });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        await tx
          .update(s.organizations)
          .set({
            currency: input.currency,
            taxRatePct: input.taxRatePct,
            pricesIncludeTax: input.pricesIncludeTax,
            updatedAt: new Date(),
          })
          .where(eq(s.organizations.id, orgId));
        await auditAdmin(tx, ctx, 'admin.orgFinanceUpdate', 'organization', orgId, input);
        return { ok: true as const };
      });
    }),
};
