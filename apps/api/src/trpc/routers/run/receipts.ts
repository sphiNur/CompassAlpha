/**
 * Owner 2026-11-23: a store's receiving record. What the store received
 * in the last RECEIPT_DAYS days, run by run: each line's quantity, the
 * verdict it was given (ok, short, wrong, quality), what arrived, the
 * note and photo, who confirmed it, and whether the purchase was revised
 * for this store after it was confirmed.
 *
 * For whoever receives there (`delivery.confirm` in that store). Store
 * staff hold no `prices.view`, so run.history refuses them and, before
 * this, a store had no record of what it received once a delivery was
 * confirmed. No money is read or returned: no price, total or payment
 * method, and not the revision's reason (free text that may talk money).
 */
import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import { RECEIPT_DAYS, StoreReceiptsInputSchema } from '@compass/contracts';
import { getActorStoreIdsForPermission } from '../../../services/storeScope';
import { orgHasStore } from '../../../services/runHistory';
import { authedProcedure } from '../../trpc';

export type ReceiptVerdict = 'ok' | 'short' | 'wrong' | 'quality';

export interface ReceiptLine {
  skuId: string;
  /** What the run brought this store (after any revision). */
  qty: string;
  verdict: ReceiptVerdict | null;
  /** What arrived, on a problem line; null when all of `qty` did. */
  receivedQty: string | null;
  note: string | null;
  photoUrl: string | null;
  /** The last purchase revision for this store after the line was confirmed. */
  revisedAt: string | null;
}

export interface Receipt {
  runId: string;
  runDate: string;
  runIndex: number;
  deliveredAt: string | null;
  confirmedAt: string;
  confirmedBy: string | null;
  lines: ReceiptLine[];
}

interface Row {
  run_id: string;
  run_date: string;
  run_index: number;
  sku_id: string;
  qty: string;
  delivered_at: string | null;
  confirmed_at: string;
  confirm_status: ReceiptVerdict | null;
  confirm_received_qty: string | null;
  confirm_note: string | null;
  confirm_photo_url: string | null;
  confirmed_by: string | null;
  revised_at: string | null;
}

/** Rows (newest confirmation first) grouped into one receipt per run. */
export function groupReceipts(rows: readonly Row[]): Receipt[] {
  const byRun = new Map<string, Receipt>();
  for (const r of rows) {
    let receipt = byRun.get(r.run_id);
    if (!receipt) {
      receipt = {
        runId: r.run_id,
        runDate: r.run_date,
        runIndex: r.run_index,
        deliveredAt: r.delivered_at,
        confirmedAt: r.confirmed_at,
        confirmedBy: r.confirmed_by,
        lines: [],
      };
      byRun.set(r.run_id, receipt);
    }
    if (r.confirmed_at > receipt.confirmedAt) {
      receipt.confirmedAt = r.confirmed_at;
      receipt.confirmedBy = r.confirmed_by;
    }
    receipt.lines.push({
      skuId: r.sku_id,
      qty: r.qty,
      verdict: r.confirm_status,
      receivedQty: r.confirm_received_qty,
      note: r.confirm_note,
      photoUrl: r.confirm_photo_url,
      revisedAt: r.revised_at,
    });
  }
  return [...byRun.values()].sort((a, b) => (a.confirmedAt < b.confirmedAt ? 1 : -1));
}

export const receiptProcedures = {
  storeReceipts: authedProcedure.input(StoreReceiptsInputSchema).query(async ({ ctx, input }) =>
    ctx.withOrg(async (tx) => {
      const session = ctx.session!;
      const allowed = await getActorStoreIdsForPermission(
        tx,
        session.memberId,
        'delivery.confirm',
        session.permissions,
      );
      const mayRead =
        allowed === null
          ? await orgHasStore(tx, session.orgId, input.storeId)
          : allowed.includes(input.storeId);
      if (!mayRead) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.missingPermission',
          cause: { missingPermission: 'delivery.confirm' },
        });
      }
      const rows = (await tx.execute(sql`
        SELECT
          r.id::text                      AS run_id,
          r.run_date::text                AS run_date,
          r.run_index::int                AS run_index,
          ris.sku_id::text                AS sku_id,
          ris.qty::text                   AS qty,
          ris.delivered_at                AS delivered_at,
          ris.confirmed_at                AS confirmed_at,
          ris.confirm_status              AS confirm_status,
          ris.confirm_received_qty::text  AS confirm_received_qty,
          ris.confirm_note                AS confirm_note,
          ris.confirm_photo_url           AS confirm_photo_url,
          u.display_name                  AS confirmed_by,
          (
            SELECT max(e.occurred_at)
            FROM domain.events e
            WHERE e.stream_id = r.id
              AND e.type = 'PurchaseRevised'
              AND e.payload->>'skuId' = ris.sku_id::text
              AND e.occurred_at > ris.confirmed_at
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(e.payload->'storeSplits') sp
                WHERE sp->>'storeId' = ris.store_id::text
              )
          )                               AS revised_at
        FROM read_model.run_item_stores_v ris
        JOIN read_model.market_runs_v r ON r.id = ris.run_id
        LEFT JOIN auth.users u ON u.id = ris.confirmed_by_user_id
        WHERE r.org_id = ${session.orgId}
          AND ris.store_id = ${input.storeId}
          AND ris.confirmed_at IS NOT NULL
          AND ris.confirmed_at >= now() - make_interval(days => ${RECEIPT_DAYS})
          AND r.status <> 'cancelled'
        ORDER BY ris.confirmed_at DESC, ris.sku_id
      `)) as unknown as Row[];
      const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
      return groupReceipts(
        rows.map((r) => ({
          ...r,
          delivered_at: iso(r.delivered_at),
          confirmed_at: iso(r.confirmed_at)!,
          revised_at: iso(r.revised_at),
        })),
      );
    }),
  ),
};
