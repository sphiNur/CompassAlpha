/**
 * Inline projector for run events. Runs in the same tx that appends events,
 * so the read model is always at lockstep with the event log.
 *
 * Same pattern as orderProjection.ts.
 */
import { eq, and, notInArray, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import type { RunEvent } from '@compass/domain/run';

export async function projectRun(db: DB, orgId: string, events: RunEvent[]): Promise<void> {
  for (const e of events) {
    switch (e.type) {
      case 'RunPlanned': {
        await db
          .insert(s.marketRunsV)
          .values({
            id: e.streamId,
            orgId,
            runDate: e.payload.runDate,
            runIndex: e.payload.runIndex,
            status: 'planned',
            purchaserMemberId: e.payload.purchaserMemberId,
            sessionIdsJson: e.payload.sessionIds as unknown as Record<string, unknown>,
            lastSeq: e.seq,
          })
          .onConflictDoNothing();
        // Bulk insert items.
        if (e.payload.plannedItems.length > 0) {
          await db
            .insert(s.runItemsV)
            .values(
              e.payload.plannedItems.map((p) => ({
                runId: e.streamId,
                skuId: p.skuId,
                plannedQty: p.qty,
                status: 'pending' as const,
              })),
            )
            .onConflictDoNothing();
        }
        break;
      }
      case 'PurchaseStarted':
        await db
          .update(s.marketRunsV)
          .set({ status: 'purchasing', startedAt: e.occurredAt, lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;
      case 'ItemPurchased': {
        await db
          .update(s.runItemsV)
          .set({
            status: 'purchased',
            purchasedQty: e.payload.actualQty,
            supplierId: e.payload.supplierId,
            unitPrice: e.payload.unitPrice,
            receiptPhotoUrl: e.payload.receiptPhotoUrl,
            // M1.14: legacy events without paymentMethod project as
            // 'cash' — same default the domain applyRun reducer uses.
            paymentMethod: e.payload.paymentMethod ?? 'cash',
            updatedAt: new Date(),
          })
          .where(and(eq(s.runItemsV.runId, e.streamId), eq(s.runItemsV.skuId, e.payload.skuId)));
        // Persist split rows so delivery+confirm can address each store separately.
        for (const split of e.payload.storeSplits) {
          await db
            .insert(s.runItemStoresV)
            .values({
              runId: e.streamId,
              skuId: e.payload.skuId,
              storeId: split.storeId,
              qty: split.qty,
            })
            .onConflictDoUpdate({
              target: [s.runItemStoresV.runId, s.runItemStoresV.skuId, s.runItemStoresV.storeId],
              set: { qty: split.qty },
            });
        }
        // Append a price_history row for analytics — runs in same tx so RLS context applies.
        await db.insert(s.priceHistory).values({
          orgId,
          skuId: e.payload.skuId,
          supplierId: e.payload.supplierId,
          runId: e.streamId,
          unitPrice: e.payload.unitPrice,
          qty: e.payload.actualQty,
          observedAt: e.occurredAt,
        });
        // Suppress unused-var warning if sql tag isn't used elsewhere in this file.
        void sql;
        await bumpSeq(db, e.streamId, e.seq);
        break;
      }
      case 'ItemUnavailable':
        await db
          .update(s.runItemsV)
          .set({ status: 'unavailable', unavailableNote: e.payload.note, updatedAt: new Date() })
          .where(and(eq(s.runItemsV.runId, e.streamId), eq(s.runItemsV.skuId, e.payload.skuId)));
        await bumpSeq(db, e.streamId, e.seq);
        break;
      case 'DeliveryStarted':
        await db
          .update(s.marketRunsV)
          .set({ status: 'delivering', lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;
      case 'StoreDelivered':
        await db
          .update(s.runItemStoresV)
          .set({ deliveredAt: e.occurredAt, deliveredByUserId: e.payload.deliveredByUserId })
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.storeId, e.payload.storeId),
            ),
          );
        await bumpSeq(db, e.streamId, e.seq);
        break;
      case 'StoreItemConfirmed':
        await db
          .update(s.runItemStoresV)
          .set({
            confirmStatus: e.payload.status,
            confirmNote: e.payload.note,
            confirmPhotoUrl: e.payload.photoUrl,
          })
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.skuId, e.payload.skuId),
              eq(s.runItemStoresV.storeId, e.payload.storeId),
            ),
          );
        await bumpSeq(db, e.streamId, e.seq);
        break;
      case 'StoreConfirmed': {
        await db
          .update(s.runItemStoresV)
          .set({ confirmedAt: e.occurredAt, confirmedByUserId: e.payload.confirmedByUserId })
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.storeId, e.payload.storeId),
            ),
          );
        // M2.0a (2026-05-08): inventory auto-receive. When a store
        // confirms a delivery the per-SKU splits become committed
        // on-hand inventory. We write one ledger row per (storeId,
        // skuId) split with the split qty as a positive delta.
        //
        // Idempotency: the partial unique index
        // `inv_mov_source_unique` on (sourceType='run', sourceId=runId,
        // storeId, skuId) means re-firing this hook (e.g. during
        // reproject) is a no-op via ON CONFLICT DO NOTHING.
        //
        // Short/wrong qty adjustments (StoreItemConfirmed
        // status='short') are NOT yet honored in the delta — the
        // operator must adjust the split before confirming, or post
        // a stocktake / wastage row after. Future M2.x can wire item-
        // level confirmation status into the inventory delta.
        const splitsForStore = await db
          .select({
            skuId: s.runItemStoresV.skuId,
            qty: s.runItemStoresV.qty,
          })
          .from(s.runItemStoresV)
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.storeId, e.payload.storeId),
            ),
          );
        if (splitsForStore.length > 0) {
          await db
            .insert(s.inventoryMovements)
            .values(
              splitsForStore.map((sp) => ({
                orgId,
                storeId: e.payload.storeId,
                skuId: sp.skuId,
                delta: sp.qty,
                reason: 'delivery_received' as const,
                sourceType: 'run' as const,
                sourceId: e.streamId,
                actorMemberId: e.actorMemberId,
                occurredAt: e.occurredAt,
              })),
            )
            .onConflictDoNothing();
        }
        await bumpSeq(db, e.streamId, e.seq);
        break;
      }
      case 'RunFinished':
        await db
          .update(s.marketRunsV)
          .set({
            status: 'finished',
            actualTotal: e.payload.totalActual,
            // M1.14: cash / transfer breakdown. For events emitted
            // before this field existed both values are absent — leave
            // the columns NULL so the FE can show "legacy total,
            // breakdown unknown" rather than a misleading 0/0 split.
            ...(e.payload.totalCash !== undefined
              ? { actualCashTotal: e.payload.totalCash }
              : {}),
            ...(e.payload.totalTransfer !== undefined
              ? { actualTransferTotal: e.payload.totalTransfer }
              : {}),
            finishedAt: e.occurredAt,
            // C.2 (M3.38): terminal — clear claim so the read model
            // doesn't keep showing a stale "claimed by X" on a closed
            // run. The reducer does the same in state.ts.
            claimedByMemberId: null,
            claimedAt: null,
            previousClaimerMemberId: null,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;
      case 'RunCancelled':
        await db
          .update(s.marketRunsV)
          .set({
            status: 'cancelled',
            claimedByMemberId: null,
            claimedAt: null,
            previousClaimerMemberId: null,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;
      case 'RunClaimed':
        // C.2 (M3.38): claim grab. The reducer mirrors this exactly —
        // sets claimer + ts. We don't clear previousClaimerMemberId
        // here so the next reviewer's banner can still show "X → Y"
        // even after the new claim lands (cleared only on
        // self-release / pagehide / terminal).
        await db
          .update(s.marketRunsV)
          .set({
            claimedByMemberId: e.payload.byMemberId,
            claimedAt: e.occurredAt,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;
      case 'RunClaimReleased': {
        // C.2 (M3.38): mirror of OrderProjection's ClaimReleased path —
        // forced releases (override / timeout) snapshot the prior
        // claimer into previous_claimer_member_id for the next
        // purchaser's banner. Self-releases (manual / pagehide) clear
        // both columns so the next claim starts fresh.
        const remembersOverride =
          e.payload.reason === 'override' || e.payload.reason === 'timeout';
        await db
          .update(s.marketRunsV)
          .set({
            claimedByMemberId: null,
            claimedAt: null,
            previousClaimerMemberId: remembersOverride
              ? sql`claimed_by_member_id`
              : null,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;
      }

      // ---- Reversal events (added 2026-05-03) ---------------------------
      case 'PurchaseRevised': {
        // Same projection as ItemPurchased on the items row…
        await db
          .update(s.runItemsV)
          .set({
            purchasedQty: e.payload.actualQty,
            supplierId: e.payload.supplierId,
            unitPrice: e.payload.unitPrice,
            receiptPhotoUrl: e.payload.receiptPhotoUrl,
            // M1.14: legacy revise events without paymentMethod leave
            // the existing column value untouched (sql undefined →
            // drizzle excludes from SET). Fresh events explicitly write
            // the new method.
            ...(e.payload.paymentMethod !== undefined
              ? { paymentMethod: e.payload.paymentMethod }
              : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(s.runItemsV.runId, e.streamId), eq(s.runItemsV.skuId, e.payload.skuId)));

        // …but the splits potentially CHANGE which stores receive this
        // SKU. Upsert the new split rows AND drop any old rows whose
        // storeId is no longer in the new split set. We can't blanket
        // DELETE all rows for the SKU first because that would reset
        // delivered_at / confirmed_at / confirm_status fields we want
        // to keep — but it's safe here because revising is blocked once
        // a destination store has been delivered to (domain guard).
        const keepStoreIds = e.payload.storeSplits.map((sp) => sp.storeId);
        if (keepStoreIds.length > 0) {
          await db
            .delete(s.runItemStoresV)
            .where(
              and(
                eq(s.runItemStoresV.runId, e.streamId),
                eq(s.runItemStoresV.skuId, e.payload.skuId),
                notInArray(s.runItemStoresV.storeId, keepStoreIds),
              ),
            );
        } else {
          // No splits at all? Drop every existing split row for this SKU.
          // (Domain rejects splitSum=0, but be defensive.)
          await db
            .delete(s.runItemStoresV)
            .where(
              and(
                eq(s.runItemStoresV.runId, e.streamId),
                eq(s.runItemStoresV.skuId, e.payload.skuId),
              ),
            );
        }
        for (const split of e.payload.storeSplits) {
          await db
            .insert(s.runItemStoresV)
            .values({
              runId: e.streamId,
              skuId: e.payload.skuId,
              storeId: split.storeId,
              qty: split.qty,
            })
            .onConflictDoUpdate({
              target: [s.runItemStoresV.runId, s.runItemStoresV.skuId, s.runItemStoresV.storeId],
              set: { qty: split.qty },
            });
        }
        // New price_history row — analytics treats each observation as a
        // discrete data point. Keeping the original row preserves the
        // "what was first recorded" audit; the new row is the latest
        // truth. (Per-row reason isn't stored on price_history; it's in
        // the event log as PurchaseRevised.payload.reason.)
        await db.insert(s.priceHistory).values({
          orgId,
          skuId: e.payload.skuId,
          supplierId: e.payload.supplierId,
          runId: e.streamId,
          unitPrice: e.payload.unitPrice,
          qty: e.payload.actualQty,
          observedAt: e.occurredAt,
        });
        await bumpSeq(db, e.streamId, e.seq);
        break;
      }

      case 'PurchaseUndone':
        // Reset the row back to pending and DELETE the per-store
        // splits. The original ItemPurchased event stays in
        // domain.events for audit, but the read-model rows reflect
        // current truth: this SKU is up for grabs again.
        await db
          .update(s.runItemsV)
          .set({
            status: 'pending',
            purchasedQty: null,
            supplierId: null,
            unitPrice: null,
            receiptPhotoUrl: null,
            // M1.14: reset payment_method to the column default 'cash'.
            // (NOT NULL constraint forbids leaving it set to a stale
            // value when the row no longer represents a purchase.)
            paymentMethod: 'cash',
            updatedAt: new Date(),
          })
          .where(
            and(eq(s.runItemsV.runId, e.streamId), eq(s.runItemsV.skuId, e.payload.skuId)),
          );
        await db
          .delete(s.runItemStoresV)
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.skuId, e.payload.skuId),
            ),
          );
        await bumpSeq(db, e.streamId, e.seq);
        break;

      case 'UnavailableUndone':
        // Pending again — clear the unavailable note. Don't touch
        // purchased fields (they were already null at unavailable-time).
        await db
          .update(s.runItemsV)
          .set({
            status: 'pending',
            unavailableNote: null,
            updatedAt: new Date(),
          })
          .where(and(eq(s.runItemsV.runId, e.streamId), eq(s.runItemsV.skuId, e.payload.skuId)));
        await bumpSeq(db, e.streamId, e.seq);
        break;

      case 'StoreDeliveryUndone':
        // Clear deliveredAt/by AND any item-level confirms scoped to
        // this store. (Item-level confirms shouldn't exist before
        // delivery, but we wipe defensively.)
        await db
          .update(s.runItemStoresV)
          .set({
            deliveredAt: null,
            deliveredByUserId: null,
            confirmStatus: null,
            confirmNote: null,
            confirmPhotoUrl: null,
          })
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.storeId, e.payload.storeId),
            ),
          );
        await bumpSeq(db, e.streamId, e.seq);
        break;

      case 'PurchaseStartUndone':
        await db
          .update(s.marketRunsV)
          .set({ status: 'planned', startedAt: null, lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;

      case 'DeliveryStartUndone':
        await db
          .update(s.marketRunsV)
          .set({ status: 'purchasing', lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;

      case 'SessionsAttachedToRun': {
        // M3.31 A.2 (2026-05-18). Two reads then writes:
        //   1. Append the new session_ids to market_runs_v.session_ids_json
        //      so subsequent run.get calls + projector replays see the
        //      complete session list.
        //   2. For each added planned item, UPSERT into run_items_v.
        //      Existing rows (SKU already in run) accumulate plannedQty
        //      additively; brand-new SKUs insert as pending.
        const current = await db
          .select({ sessionIdsJson: s.marketRunsV.sessionIdsJson })
          .from(s.marketRunsV)
          .where(eq(s.marketRunsV.id, e.streamId))
          .limit(1);
        const existingIds = (current[0]?.sessionIdsJson as unknown as string[] | null) ?? [];
        const merged = [...existingIds, ...e.payload.sessionIds];
        await db
          .update(s.marketRunsV)
          .set({
            sessionIdsJson: merged as unknown as Record<string, unknown>,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.marketRunsV.id, e.streamId));

        for (const added of e.payload.addedPlannedItems) {
          await db
            .insert(s.runItemsV)
            .values({
              runId: e.streamId,
              skuId: added.skuId,
              plannedQty: added.qty,
              status: 'pending' as const,
            })
            .onConflictDoUpdate({
              target: [s.runItemsV.runId, s.runItemsV.skuId],
              // Sum existing.planned_qty + delta. We can do it via SQL
              // expression so the read-then-write race against a
              // concurrent purchase doesn't lose data.
              set: {
                plannedQty: sql`${s.runItemsV.plannedQty} + ${added.qty}::numeric`,
                updatedAt: new Date(),
              },
            });
        }
        break;
      }
    }
  }
}

async function bumpSeq(db: DB, streamId: string, seq: number): Promise<void> {
  await db
    .update(s.marketRunsV)
    .set({ lastSeq: seq, updatedAt: new Date() })
    .where(eq(s.marketRunsV.id, streamId));
}
