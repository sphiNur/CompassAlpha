/**
 * The organisation's expense templates as one reader may see them, for
 * the admin list and the run sheet's shortcuts. Review ADM2-01
 * (2026-11-12): each read the table itself and handed every reader the
 * default unit price, prices.view or not.
 */
import { and, eq } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import { priceStoreIds, pricesVisibleAnywhere } from './priceRedaction';

export async function readExpenseTemplates(
  tx: DB,
  session: { orgId: string; memberId: string; permissions: ReadonlySet<string> },
  includeArchived: boolean,
) {
  const rows = await tx
    .select({
      id: s.expenseTemplates.id,
      label: s.expenseTemplates.label,
      unitHint: s.expenseTemplates.unitHint,
      defaultQty: s.expenseTemplates.defaultQty,
      defaultUnitPrice: s.expenseTemplates.defaultUnitPrice,
      defaultPaymentMethod: s.expenseTemplates.defaultPaymentMethod,
      sortIndex: s.expenseTemplates.sortIndex,
      isArchived: s.expenseTemplates.isArchived,
    })
    .from(s.expenseTemplates)
    .where(
      and(
        eq(s.expenseTemplates.orgId, session.orgId),
        ...(includeArchived ? [] : [eq(s.expenseTemplates.isArchived, false)]),
      ),
    )
    .orderBy(s.expenseTemplates.sortIndex, s.expenseTemplates.createdAt);
  // A template's price belongs to no store, so it follows the rule for
  // org-wide figures such as dish prices: prices.view somewhere.
  const showPrices = pricesVisibleAnywhere(await priceStoreIds(tx, session));
  return rows.map((r) => ({ ...r, defaultUnitPrice: showPrices ? r.defaultUnitPrice : null }));
}
