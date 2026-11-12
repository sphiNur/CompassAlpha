/** The organisation's recurring run expenses (expense templates). */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import {
  ExpenseTemplateCreateInputSchema,
  ExpenseTemplateDeleteInputSchema,
  ExpenseTemplateUpdateInputSchema,
} from '@compass/contracts';
import { authedProcedure } from '../../trpc';
import { auditChanges } from '../../../services/auditChanges';
import { requireAdmin, requireOrgAdmin } from './guards';
import { broadcastCatalog } from './notify';
import { orgRowOr404 } from './orgRows';
import { auditAdmin } from '../../../services/adminAudit';
import { readExpenseTemplates } from '../../../services/expenseTemplates';

export const expenseTemplateProcedures = {
  // ============ EXPENSE TEMPLATES (M3.57) ============
  // Org-level recurring expenses (porter / taxi / parking / etc.). The
  // admin maintains the list; every new run picks them up via
  // run.create's auto-attach loop. Templates are CRUD-managed (not
  // event-sourced) because they describe SHAPE not HISTORY — editing
  // one doesn't replay through past runs. Mutations require org.admin
  // (chain-wide setting); reads only need users.manage (so store-tier
  // admins can audit the configured list).

  expenseTemplateList: authedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg((tx) =>
        readExpenseTemplates(tx, ctx.session!, input?.includeArchived ?? false),
      );
    }),

  expenseTemplateCreate: authedProcedure
    .input(ExpenseTemplateCreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const [created] = await tx
          .insert(s.expenseTemplates)
          .values({
            orgId,
            label: input.label,
            unitHint: input.unitHint ?? null,
            defaultQty: input.defaultQty,
            defaultUnitPrice: input.defaultUnitPrice,
            defaultPaymentMethod: input.defaultPaymentMethod,
            sortIndex: input.sortIndex,
          })
          .returning();
        await auditAdmin(
          tx,
          ctx,
          'admin.expenseTemplate.create',
          'expenseTemplate',
          created!.id,
          input,
        );
        broadcastCatalog(orgId, 'expenseTemplate');
        return { id: created!.id };
      });
    }),

  expenseTemplateUpdate: authedProcedure
    .input(ExpenseTemplateUpdateInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const existing = await orgRowOr404(
          tx,
          s.expenseTemplates,
          orgId,
          input.templateId,
          'admin.errors.expenseTemplateNotFound',
        );
        // ADM2-36: typed by the table, as the catalog's edits.
        const patch: Partial<typeof s.expenseTemplates.$inferInsert> = { updatedAt: new Date() };
        if (input.label !== undefined) patch.label = input.label;
        if (input.unitHint !== undefined) patch.unitHint = input.unitHint;
        if (input.defaultQty !== undefined) patch.defaultQty = input.defaultQty;
        if (input.defaultUnitPrice !== undefined) patch.defaultUnitPrice = input.defaultUnitPrice;
        if (input.defaultPaymentMethod !== undefined)
          patch.defaultPaymentMethod = input.defaultPaymentMethod;
        if (input.sortIndex !== undefined) patch.sortIndex = input.sortIndex;
        if (input.isArchived !== undefined) patch.isArchived = input.isArchived;
        await tx
          .update(s.expenseTemplates)
          .set(patch)
          .where(eq(s.expenseTemplates.id, input.templateId));
        const changes = auditChanges(
          existing,
          patch,
          [
            'label',
            'unitHint',
            'defaultQty',
            'defaultUnitPrice',
            'defaultPaymentMethod',
            'sortIndex',
          ],
          ['defaultQty', 'defaultUnitPrice'],
        );
        await auditAdmin(
          tx,
          ctx,
          'admin.expenseTemplate.update',
          'expenseTemplate',
          input.templateId,
          { ...input, changes },
        );
        broadcastCatalog(orgId, 'expenseTemplate');
        return { ok: true };
      });
    }),

  expenseTemplateDelete: authedProcedure
    .input(ExpenseTemplateDeleteInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        await orgRowOr404(
          tx,
          s.expenseTemplates,
          orgId,
          input.templateId,
          'admin.errors.expenseTemplateNotFound',
        );
        // Soft-delete to keep old runs' "auto-attached from template X"
        // audit trail intact. Archived templates skip the auto-attach
        // loop in run.create.
        await tx
          .update(s.expenseTemplates)
          .set({ isArchived: true, updatedAt: new Date() })
          .where(eq(s.expenseTemplates.id, input.templateId));
        await auditAdmin(
          tx,
          ctx,
          'admin.expenseTemplate.delete',
          'expenseTemplate',
          input.templateId,
          input,
        );
        broadcastCatalog(orgId, 'expenseTemplate');
        return { ok: true };
      });
    }),
};
