/**
 * Review ADM2-36 (2026-11-12): "read the row with this id in the caller's
 * organisation, or refuse with NOT_FOUND" was written out at every edit
 * and archive of a category, product, supplier, expense template and
 * store, the same five lines with only the table and the message changed.
 */
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DB } from '@compass/db';
import type { CatalogKey } from '@compass/i18n';

/** A table with an `id` and the `orgId` it belongs to. */
type OrgTable = PgTable & { id: PgColumn; orgId: PgColumn };

/**
 * The row of `table` with `id` in organisation `orgId`, or NOT_FOUND with
 * `notFound` as the message (typed as a catalog key: the scan of thrown
 * keys reads only literal messages).
 */
export async function orgRowOr404<T extends OrgTable>(
  tx: DB,
  table: T,
  orgId: string,
  id: string,
  notFound: CatalogKey,
): Promise<T['$inferSelect']> {
  // Drizzle cannot work out the selection of a table that is a type
  // parameter, so the select reads a plain table and the row is given back
  // as what selecting `table` returns: all its columns.
  const [row] = await tx
    .select()
    .from(table as PgTable)
    .where(and(eq(table.id, id), eq(table.orgId, orgId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: notFound });
  return row as T['$inferSelect'];
}
