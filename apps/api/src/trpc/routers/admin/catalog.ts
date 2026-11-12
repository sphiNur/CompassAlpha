/**
 * The catalog: categories, products (SKUs), suppliers, and importing
 * another organisation's catalog.
 */
import { TRPCError } from '@trpc/server';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { inSystem, schema as s, withOrgContext } from '@compass/db';
import {
  CategoryCreateInputSchema,
  CategoryDeleteInputSchema,
  CategoryUpdateInputSchema,
  SkuCreateInputSchema,
  SkuDeleteInputSchema,
  SkuUpdateInputSchema,
  SupplierCreateInputSchema,
  SupplierDeleteInputSchema,
  SupplierUpdateInputSchema,
  CatalogImportInputSchema,
} from '@compass/contracts';
import { authedProcedure, withUniqueKey } from '../../trpc';
import { hasGlobalOrgAdmin } from '../../../services/orgAdmin';
import { auditChanges } from '../../../services/auditChanges';
import {
  applyCatalogCopy,
  readCatalogSnapshot,
  type CatalogSnapshot,
} from '../../../services/catalogCopy';
import { requireAdmin, requireOrgAdmin, requireGlobalOrgAdmin } from './guards';
import { broadcastCatalog } from './notify';
import { categoryNamesForAudit, auditAdmin } from '../../../services/adminAudit';
import type { RequestContext } from '../../context';

/**
 * The caller's other organisations where they are an org-wide admin —
 * the only ones a catalog may be imported from. Memberships are found
 * the way switchOrganization finds them; the admin check then runs
 * inside each organisation.
 */
async function catalogSourceMemberships(
  ctx: RequestContext,
): Promise<Array<{ orgId: string; orgName: string; memberId: string }>> {
  const rows = await inSystem(ctx.db, 'auth', (tx) =>
    tx
      .select({ orgId: s.organizations.id, orgName: s.organizations.name, memberId: s.members.id })
      .from(s.members)
      .innerJoin(s.organizations, eq(s.organizations.id, s.members.orgId))
      .where(
        and(
          eq(s.members.userId, ctx.session!.userId),
          eq(s.members.status, 'active'),
          isNull(s.organizations.deletedAt),
        ),
      )
      .orderBy(s.organizations.name),
  );
  const others = rows.filter((r) => r.orgId !== ctx.session!.orgId);
  const admin = await Promise.all(
    others.map((r) => withOrgContext(ctx.db, r.orgId, (tx) => hasGlobalOrgAdmin(tx, r.memberId))),
  );
  return others.filter((_, i) => admin[i]);
}

/** Read the source catalog, after checking the caller administers it. */
async function readCatalogSource(
  ctx: RequestContext,
  sourceOrgId: string,
): Promise<CatalogSnapshot> {
  const allowed = await catalogSourceMemberships(ctx);
  if (!allowed.some((m) => m.orgId === sourceOrgId)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.missingPermission',
      cause: { missingPermission: 'org.admin' },
    });
  }
  return withOrgContext(ctx.db, sourceOrgId, (tx) => readCatalogSnapshot(tx, sourceOrgId));
}

export const catalogProcedures = {
  // ============ CATEGORIES ============

  categoryList: authedProcedure.query(async ({ ctx }) => {
    requireAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // Review ADM2-17 (2026-11-12): the slug, then the id, break ties. New
      // categories all start at 100, and rows with one sort number came back
      // in whatever order Postgres found them, so the list could reshuffle
      // on a refresh. The order page's catalog.skus does this (DX-ORD-6).
      return tx
        .select({
          id: s.categories.id,
          slug: s.categories.slug,
          names: s.categories.names,
          sortIndex: s.categories.sortIndex,
          icon: s.categories.icon,
          isArchived: s.categories.isArchived,
        })
        .from(s.categories)
        .where(eq(s.categories.orgId, orgId))
        .orderBy(asc(s.categories.sortIndex), asc(s.categories.slug), asc(s.categories.id));
    });
  }),

  categoryCreate: authedProcedure
    .input(CategoryCreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      // M3.3: categories are org-wide (no store_id) — org.admin only.
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const [created] = await withUniqueKey(
          tx
            .insert(s.categories)
            .values({
              orgId,
              slug: input.slug,
              names: input.names,
              sortIndex: input.sortIndex,
            })
            .returning(),
          'admin.errors.slugTaken',
        );
        await auditAdmin(tx, ctx, 'admin.category.create', 'category', created!.id, input);
        broadcastCatalog(orgId, 'category');
        return { id: created!.id };
      });
    }),

  categoryUpdate: authedProcedure
    .input(CategoryUpdateInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const existing = await tx.query.categories.findFirst({
          where: (c, { eq: eq2, and: and2 }) =>
            and2(eq2(c.id, input.categoryId), eq2(c.orgId, orgId)),
        });
        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.categoryNotFound' });
        }
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (input.slug !== undefined) patch.slug = input.slug;
        if (input.names !== undefined) patch.names = input.names;
        if (input.sortIndex !== undefined) patch.sortIndex = input.sortIndex;
        if (input.isArchived !== undefined) patch.isArchived = input.isArchived;
        await withUniqueKey(
          tx.update(s.categories).set(patch).where(eq(s.categories.id, input.categoryId)),
          'admin.errors.slugTaken',
        );
        await auditAdmin(tx, ctx, 'admin.category.update', 'category', input.categoryId, {
          ...input,
          changes: auditChanges(existing, patch, ['slug', 'names', 'sortIndex']),
        });
        broadcastCatalog(orgId, 'category');
        return { ok: true };
      });
    }),

  categoryDelete: authedProcedure
    .input(CategoryDeleteInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const existing = await tx.query.categories.findFirst({
          where: (c, { eq: eq2, and: and2 }) =>
            and2(eq2(c.id, input.categoryId), eq2(c.orgId, orgId)),
        });
        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.categoryNotFound' });
        }
        await tx
          .update(s.categories)
          .set({ isArchived: true, updatedAt: new Date() })
          .where(eq(s.categories.id, input.categoryId));
        await auditAdmin(tx, ctx, 'admin.category.delete', 'category', input.categoryId, input);
        broadcastCatalog(orgId, 'category');
        return { ok: true };
      });
    }),

  // ============ SKUs ============

  skuList: authedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const includeArchived = input?.includeArchived ?? false;
        // ADM2-17: as categoryList, by the code (as catalog.skus) and then
        // the id, since most products have no code.
        return tx
          .select({
            id: s.skus.id,
            categoryId: s.skus.categoryId,
            code: s.skus.code,
            names: s.skus.names,
            unit: s.skus.unit,
            step: s.skus.step,
            imageUrl: s.skus.imageUrl,
            suggestedQty: s.skus.suggestedQty,
            sortIndex: s.skus.sortIndex,
            isArchived: s.skus.isArchived,
          })
          .from(s.skus)
          .where(
            includeArchived
              ? eq(s.skus.orgId, orgId)
              : and(eq(s.skus.orgId, orgId), eq(s.skus.isArchived, false)),
          )
          .orderBy(asc(s.skus.sortIndex), asc(s.skus.code), asc(s.skus.id));
      });
    }),

  skuCreate: authedProcedure.input(SkuCreateInputSchema).mutation(async ({ ctx, input }) => {
    // M3.3: SKUs are org-wide; only org.admin can mint new ones.
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // SECURITY (2026-05-04): verify categoryId belongs to actor's org
      // — otherwise a UUID from another org could attach this SKU to
      // their category (cross-tenant data leak).
      if (input.categoryId) {
        const cat = await tx.query.categories.findFirst({
          where: (c, { eq: eq2, and: and2 }) =>
            and2(eq2(c.id, input.categoryId!), eq2(c.orgId, orgId)),
        });
        if (!cat) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.categoryNotFound' });
        }
      }
      const [created] = await withUniqueKey(
        tx
          .insert(s.skus)
          .values({
            orgId,
            categoryId: input.categoryId ?? null,
            code: input.code ?? null,
            names: input.names,
            unit: input.unit,
            step: input.step,
            sortIndex: input.sortIndex,
          })
          .returning(),
        'admin.errors.codeTaken',
      );
      await auditAdmin(tx, ctx, 'admin.sku.create', 'sku', created!.id, input);
      broadcastCatalog(orgId, 'sku');
      return { id: created!.id };
    });
  }),

  skuUpdate: authedProcedure.input(SkuUpdateInputSchema).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.skus.findFirst({
        where: (k, { eq: eq2, and: and2 }) => and2(eq2(k.id, input.skuId), eq2(k.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.skuNotFound' });
      }
      // Cross-tenant gate on categoryId — same as skuCreate.
      if (input.categoryId) {
        const cat = await tx.query.categories.findFirst({
          where: (c, { eq: eq2, and: and2 }) =>
            and2(eq2(c.id, input.categoryId!), eq2(c.orgId, orgId)),
        });
        if (!cat) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.categoryNotFound' });
        }
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
      if (input.code !== undefined) patch.code = input.code;
      if (input.names !== undefined) patch.names = input.names;
      if (input.unit !== undefined) patch.unit = input.unit;
      if (input.step !== undefined) patch.step = input.step;
      if (input.sortIndex !== undefined) patch.sortIndex = input.sortIndex;
      if (input.isArchived !== undefined) patch.isArchived = input.isArchived;
      await withUniqueKey(
        tx.update(s.skus).set(patch).where(eq(s.skus.id, input.skuId)),
        'admin.errors.codeTaken',
      );
      const changes = auditChanges(
        existing,
        patch,
        ['code', 'names', 'unit', 'step', 'sortIndex'],
        ['step'],
      );
      if (patch.categoryId !== undefined && patch.categoryId !== existing.categoryId) {
        changes.category = [
          await categoryNamesForAudit(tx, existing.categoryId),
          await categoryNamesForAudit(tx, patch.categoryId as string | null),
        ];
      }
      await auditAdmin(tx, ctx, 'admin.sku.update', 'sku', input.skuId, { ...input, changes });
      broadcastCatalog(orgId, 'sku');
      return { ok: true };
    });
  }),

  skuDelete: authedProcedure.input(SkuDeleteInputSchema).mutation(async ({ ctx, input }) => {
    requireOrgAdmin(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      const existing = await tx.query.skus.findFirst({
        where: (k, { eq: eq2, and: and2 }) => and2(eq2(k.id, input.skuId), eq2(k.orgId, orgId)),
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.skuNotFound' });
      }
      // Soft delete; hard delete would cascade through every order_item ever
      // referencing this SKU.
      await tx
        .update(s.skus)
        .set({ isArchived: true, updatedAt: new Date() })
        .where(eq(s.skus.id, input.skuId));
      await auditAdmin(tx, ctx, 'admin.sku.delete', 'sku', input.skuId, input);
      // BUG FIX (2026-05-04): missing broadcast — admins on the catalog
      // page would not auto-refresh after archive.
      broadcastCatalog(orgId, 'sku');
      return { ok: true };
    });
  }),

  // ============ SUPPLIERS ============

  supplierList: authedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const includeArchived = input?.includeArchived ?? false;
        return tx
          .select({
            id: s.suppliers.id,
            name: s.suppliers.name,
            contactPhone: s.suppliers.contactPhone,
            contactTg: s.suppliers.contactTg,
            address: s.suppliers.address,
            photoUrl: s.suppliers.photoUrl,
            rating: s.suppliers.rating,
            reliabilityScore: s.suppliers.reliabilityScore,
            priceTrustScore: s.suppliers.priceTrustScore,
            notes: s.suppliers.notes,
            isArchived: s.suppliers.isArchived,
          })
          .from(s.suppliers)
          .where(
            includeArchived
              ? eq(s.suppliers.orgId, orgId)
              : and(eq(s.suppliers.orgId, orgId), eq(s.suppliers.isArchived, false)),
          )
          .orderBy(s.suppliers.name);
      });
    }),

  supplierCreate: authedProcedure
    .input(SupplierCreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      // M3.3: suppliers are org-wide; only org.admin manages them.
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const [created] = await tx
          .insert(s.suppliers)
          .values({
            orgId,
            name: input.name,
            contactPhone: input.contactPhone ?? null,
            contactTg: input.contactTg ?? null,
            address: input.address ?? null,
            notes: input.notes ?? null,
          })
          .returning();
        await auditAdmin(tx, ctx, 'admin.supplier.create', 'supplier', created!.id, input);
        broadcastCatalog(orgId, 'supplier');
        return { id: created!.id };
      });
    }),

  supplierUpdate: authedProcedure
    .input(SupplierUpdateInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const existing = await tx.query.suppliers.findFirst({
          where: (sp, { eq: eq2, and: and2 }) =>
            and2(eq2(sp.id, input.supplierId), eq2(sp.orgId, orgId)),
        });
        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.supplierNotFound' });
        }
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (input.name !== undefined) patch.name = input.name;
        if (input.contactPhone !== undefined) patch.contactPhone = input.contactPhone;
        if (input.contactTg !== undefined) patch.contactTg = input.contactTg;
        if (input.address !== undefined) patch.address = input.address;
        if (input.notes !== undefined) patch.notes = input.notes;
        if (input.isArchived !== undefined) patch.isArchived = input.isArchived;
        await tx.update(s.suppliers).set(patch).where(eq(s.suppliers.id, input.supplierId));
        await auditAdmin(tx, ctx, 'admin.supplier.update', 'supplier', input.supplierId, {
          ...input,
          changes: auditChanges(existing, patch, [
            'name',
            'contactPhone',
            'contactTg',
            'address',
            'notes',
          ]),
        });
        broadcastCatalog(orgId, 'supplier');
        return { ok: true };
      });
    }),

  supplierDelete: authedProcedure
    .input(SupplierDeleteInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireOrgAdmin(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const existing = await tx.query.suppliers.findFirst({
          where: (sp, { eq: eq2, and: and2 }) =>
            and2(eq2(sp.id, input.supplierId), eq2(sp.orgId, orgId)),
        });
        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.supplierNotFound' });
        }
        await tx
          .update(s.suppliers)
          .set({ isArchived: true, updatedAt: new Date() })
          .where(eq(s.suppliers.id, input.supplierId));
        await auditAdmin(tx, ctx, 'admin.supplier.delete', 'supplier', input.supplierId, input);
        broadcastCatalog(orgId, 'supplier');
        return { ok: true };
      });
    }),

  // ============ CATALOG IMPORT (2026-10-23) ============
  // Copy another organisation's catalog into this one. The caller must be
  // an org-wide admin in BOTH organisations; see services/catalogCopy.ts
  // for what is copied and what is left behind.

  /** Other organisations this admin may import a catalog from. */
  catalogImportSources: authedProcedure.query(async ({ ctx }) => {
    await requireGlobalOrgAdmin(ctx);
    const memberships = await catalogSourceMemberships(ctx);
    return memberships.map(({ orgId, orgName }) => ({ orgId, orgName }));
  }),

  catalogImportPreview: authedProcedure
    .input(CatalogImportInputSchema)
    .query(async ({ ctx, input }) => {
      await requireGlobalOrgAdmin(ctx);
      const source = await readCatalogSource(ctx, input.sourceOrgId);
      return ctx.withOrg((tx) =>
        applyCatalogCopy(tx, ctx.session!.orgId, source, {
          includeSuppliers: input.includeSuppliers,
          dryRun: true,
        }),
      );
    }),

  catalogImport: authedProcedure
    .input(CatalogImportInputSchema)
    .mutation(async ({ ctx, input }) => {
      await requireGlobalOrgAdmin(ctx);
      const source = await readCatalogSource(ctx, input.sourceOrgId);
      const orgId = ctx.session!.orgId;
      const summary = await ctx.withOrg(async (tx) => {
        const result = await applyCatalogCopy(tx, orgId, source, {
          includeSuppliers: input.includeSuppliers,
          dryRun: false,
        });
        await auditAdmin(tx, ctx, 'admin.catalog.import', 'catalog', null, {
          ...input,
          summary: result,
        });
        return result;
      });
      broadcastCatalog(orgId, 'category');
      broadcastCatalog(orgId, 'sku');
      if (input.includeSuppliers) broadcastCatalog(orgId, 'supplier');
      return summary;
    }),
};
