/**
 * Inline projector for run events. Runs in the same tx that appends events,
 * so the read model is always at lockstep with the event log.
 *
 * Same pattern as the order projector (@compass/streams). The run claim
 * columns are projected there too, by projectRunClaim, which the worker
 * shares for its timed-out release (review ORD-07).
 */
import { and, asc, desc, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import { milliQty, qtyMilli, qtyMilliOrZero } from '@compass/contracts';
import { DomainError } from '@compass/domain';
import type { RunEvent } from '@compass/domain/run';
import { projectRunClaim, readRunEvents } from '@compass/streams';
import { runCorrections } from './runCorrections';

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
            sessionIdsJson: e.payload.sessionIds,
            lastSeq: e.seq,
          })
          // RUNAPI-04 (2026-11-09): only a replay of this same run is
          // skipped. Without a target, a conflict on the one-live-run or
          // (org, date, index) index was skipped too, and the item insert
          // below then failed its foreign key: a 500 where run.create
          // means to find the run that won.
          .onConflictDoNothing({ target: s.marketRunsV.id });
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
        // Streams written before PurchaseItem refused an already-bought
        // item can carry a second ItemPurchased for the same SKU. The
        // aggregate replaces its splits wholesale, so a rebuild has to
        // drop the stores the later event no longer names.
        const purchasedStoreIds = e.payload.storeSplits.map((sp) => sp.storeId);
        await db
          .delete(s.runItemStoresV)
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.skuId, e.payload.skuId),
              purchasedStoreIds.length > 0
                ? notInArray(s.runItemStoresV.storeId, purchasedStoreIds)
                : undefined,
            ),
          );
        // Persist split rows so delivery+confirm can address each store separately.
        for (const split of e.payload.storeSplits) {
          await db
            .insert(s.runItemStoresV)
            .values({
              runId: e.streamId,
              skuId: e.payload.skuId,
              storeId: split.storeId,
              qty: split.qty,
              unitPrice: split.unitPrice ?? null,
              paymentMethod: split.paymentMethod ?? null,
            })
            .onConflictDoUpdate({
              target: [s.runItemStoresV.runId, s.runItemStoresV.skuId, s.runItemStoresV.storeId],
              set: {
                qty: split.qty,
                unitPrice: split.unitPrice ?? null,
                paymentMethod: split.paymentMethod ?? null,
              },
            });
        }
        const run = await runPhaseOf(db, e.streamId);
        await restoreAmendedVerdicts(db, e, run, purchasedStoreIds);
        // Append a price_history row for analytics — runs in same tx so RLS context applies.
        await insertPriceObservations(db, orgId, e, run);
        await bumpSeq(db, e.streamId, e.seq);
        break;
      }
      case 'PurchaserItemAdded': {
        // M3.41 (2026-05-21): purchaser added a SKU mid-run. INSERT (not
        // UPDATE) a fresh run_items_v row — the domain layer guaranteed
        // this skuId wasn't in the run before this event. Marks
        // added_by_purchaser=true so reports can call out "ordered vs
        // added beyond the ask". Otherwise the shape matches
        // ItemPurchased's outcome: status=purchased, plannedQty=actualQty
        // (no prior plan), storeSplits projected to run_item_stores_v,
        // price_history row appended for analytics.
        await db
          .insert(s.runItemsV)
          .values({
            runId: e.streamId,
            skuId: e.payload.skuId,
            plannedQty: e.payload.actualQty,
            purchasedQty: e.payload.actualQty,
            supplierId: e.payload.supplierId,
            unitPrice: e.payload.unitPrice,
            status: 'purchased',
            paymentMethod: e.payload.paymentMethod,
            receiptPhotoUrl: e.payload.receiptPhotoUrl,
            addedByPurchaser: true,
          })
          .onConflictDoNothing();
        for (const split of e.payload.storeSplits) {
          await db
            .insert(s.runItemStoresV)
            .values({
              runId: e.streamId,
              skuId: e.payload.skuId,
              storeId: split.storeId,
              qty: split.qty,
              unitPrice: split.unitPrice ?? null,
              paymentMethod: split.paymentMethod ?? null,
            })
            .onConflictDoUpdate({
              target: [s.runItemStoresV.runId, s.runItemStoresV.skuId, s.runItemStoresV.storeId],
              set: {
                qty: split.qty,
                unitPrice: split.unitPrice ?? null,
                paymentMethod: split.paymentMethod ?? null,
              },
            });
        }
        const run = await runPhaseOf(db, e.streamId);
        await restoreAmendedVerdicts(
          db,
          e,
          run,
          e.payload.storeSplits.map((sp) => sp.storeId),
        );
        await insertPriceObservations(db, orgId, e, run);
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
      case 'RunExpenseAdded': {
        // M3.44 (2026-05-22): insert a row into run_expenses_v. The
        // domain layer guards against duplicate expenseId, but the
        // projector also uses ON CONFLICT DO NOTHING so a defensive
        // replay never crashes.
        const inserted = await db
          .insert(s.runExpensesV)
          .values({
            id: e.payload.expenseId,
            runId: e.streamId,
            orgId,
            label: e.payload.label,
            unitHint: e.payload.unitHint,
            qty: e.payload.qty,
            unitPrice: e.payload.unitPrice,
            storeSplitsJson: e.payload.storeSplits as unknown as Record<string, unknown>,
            paymentMethod: e.payload.paymentMethod,
            receiptPhotoUrl: e.payload.receiptPhotoUrl,
            reason: e.payload.reason,
            addedByMemberId: e.payload.byMemberId,
            addedAt: e.occurredAt,
          })
          .onConflictDoNothing()
          .returning({ id: s.runExpensesV.id });
        // Security scan F2 (2026-10-31): the id is chosen by the client
        // and the domain only knows this run's own expenses. An id that
        // already belongs to another run (or another organisation) used
        // to be accepted with no row written here, and a later
        // RunExpenseRemoved then soft-deleted the OTHER run's expense.
        // Refuse it; the transaction (and the event) rolls back.
        if (inserted.length === 0) {
          const [own] = await db
            .select({ id: s.runExpensesV.id })
            .from(s.runExpensesV)
            .where(
              and(
                eq(s.runExpensesV.id, e.payload.expenseId),
                eq(s.runExpensesV.runId, e.streamId),
              ),
            )
            .limit(1);
          if (!own) throw new DomainError('VALIDATION', 'run.errors.expenseIdTaken');
        }
        await bumpSeq(db, e.streamId, e.seq);
        break;
      }
      case 'RunExpenseRemoved': {
        // M3.44: soft-delete — fill removed_at + actor + reason. The
        // row stays so admin reports can show "added then removed".
        // The FE filters by `removed_at IS NULL` for the active list.
        await db
          .update(s.runExpensesV)
          .set({
            removedAt: e.occurredAt,
            removedByMemberId: e.payload.byMemberId,
            removeReason: e.payload.reason,
          })
          // F2: only this run's expense, whatever the id names elsewhere.
          .where(
            and(
              eq(s.runExpensesV.id, e.payload.expenseId),
              eq(s.runExpensesV.runId, e.streamId),
            ),
          );
        await bumpSeq(db, e.streamId, e.seq);
        break;
      }
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
            // 2026-10-21 CA-06: null for 'ok' and for legacy events.
            confirmReceivedQty: e.payload.receivedQty ?? null,
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
        // 2026-10-21 CA-06: a line the store marked short / wrong /
        // quality books the qty it reported as received, not the split.
        // 'ok' lines, undecided lines, and every confirmation recorded
        // before receivedQty existed (confirm_received_qty IS NULL) book
        // the full split qty exactly as before — so reprojecting old
        // streams produces identical movements.
        const splitsForStore = await db
          .select({
            skuId: s.runItemStoresV.skuId,
            qty: s.runItemStoresV.qty,
            confirmStatus: s.runItemStoresV.confirmStatus,
            confirmReceivedQty: s.runItemStoresV.confirmReceivedQty,
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
                delta: receivedDelta(sp),
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
      case 'RunDateChanged':
        // 2026-07-30: the only writer of `runDate` other than RunPlanned.
        // History groups and totals by this column, so this is what makes
        // a mis-dated run's spend land in the right day/month.
        await db
          .update(s.marketRunsV)
          .set({
            runDate: e.payload.runDate,
            ...(e.payload.runIndex !== undefined ? { runIndex: e.payload.runIndex } : {}),
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;
      case 'RunReopened':
        // 2026-07-06: super-admin reopened a finished run. Move the phase
        // to `amending`; item/split/expense rows are untouched (the edit
        // events that follow project normally). The frozen totals stay as
        // they were until RunRefinalized rewrites them.
        await db
          .update(s.marketRunsV)
          .set({ status: 'amending', lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.marketRunsV.id, e.streamId));
        break;
      case 'RunRefinalized':
        // Correction closed: rewrite the frozen totals from the amended
        // state (recomputed in the aggregate) and return to `finished`.
        await db
          .update(s.marketRunsV)
          .set({
            status: 'finished',
            actualTotal: e.payload.totalActual,
            actualCashTotal: e.payload.totalCash,
            actualTransferTotal: e.payload.totalTransfer,
            // DLV-15 (2026-10-30): keep the time the run finished. A
            // correction used to overwrite it with the time it closed;
            // the correction's own time is on this event.
            finishedAt: sql`coalesce(${s.marketRunsV.finishedAt}, ${e.occurredAt.toISOString()}::timestamptz)`,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.marketRunsV.id, e.streamId));
        await syncAmendMovements(db, orgId, e);
        break;
      case 'RunClaimed':
      case 'RunClaimReleased':
        // C.2 (M3.38): the claim columns, shared with the worker.
        await projectRunClaim(db, e);
        break;

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

        // …but the splits can change which stores receive this SKU: drop
        // the rows of stores the revision no longer names and upsert the
        // rest. Not a blanket DELETE: a kept row keeps its delivery and
        // receipt (the upsert sets quantity, price and payment only).
        // Once a store has the goods its quantity stands, except in a
        // correction of a finished run. There a store can be taken off
        // the line and given it back; its new row gets its receipt back
        // below (RUNAPI-07).
        const run = await runPhaseOf(db, e.streamId);
        const keepStoreIds = e.payload.storeSplits.map((sp) => sp.storeId);
        const rowsBefore = await db
          .select({ storeId: s.runItemStoresV.storeId })
          .from(s.runItemStoresV)
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.skuId, e.payload.skuId),
            ),
          );
        const hadRow = new Set(rowsBefore.map((r) => r.storeId));
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
              unitPrice: split.unitPrice ?? null,
              paymentMethod: split.paymentMethod ?? null,
            })
            .onConflictDoUpdate({
              target: [s.runItemStoresV.runId, s.runItemStoresV.skuId, s.runItemStoresV.storeId],
              set: {
                qty: split.qty,
                unitPrice: split.unitPrice ?? null,
                paymentMethod: split.paymentMethod ?? null,
              },
            });
        }
        await restoreAmendedVerdicts(
          db,
          e,
          run,
          keepStoreIds.filter((storeId) => !hadRow.has(storeId)),
        );
        // New price_history row — analytics treats each observation as a
        // discrete data point. Keeping the original row preserves the
        // "what was first recorded" audit; the new row is the latest
        // truth. (Per-row reason isn't stored on price_history; it's in
        // the event log as PurchaseRevised.payload.reason.)
        await insertPriceObservations(db, orgId, e, run);
        await bumpSeq(db, e.streamId, e.seq);
        break;
      }

      case 'PurchaseUndone':
        // Reset the row back to pending and DELETE the per-store
        // splits. The original ItemPurchased event stays in
        // domain.events for audit, but the read-model rows reflect
        // current truth: this SKU is up for grabs again. A row the
        // purchaser added goes away entirely (BUY-4, as in the domain
        // state); the update below then matches nothing.
        await db
          .delete(s.runItemStoresV)
          .where(
            and(
              eq(s.runItemStoresV.runId, e.streamId),
              eq(s.runItemStoresV.skuId, e.payload.skuId),
            ),
          );
        await db
          .delete(s.runItemsV)
          .where(
            and(
              eq(s.runItemsV.runId, e.streamId),
              eq(s.runItemsV.skuId, e.payload.skuId),
              eq(s.runItemsV.addedByPurchaser, true),
            ),
          );
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
        await supersedePriceObservations(db, orgId, e.streamId, e.payload.skuId, e.occurredAt);
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

      case 'TopUpDismissed':
        // BUY-5: domain-state only (see run.get); nothing to project.
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
            confirmReceivedQty: null,
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
        const existingIds = current[0]?.sessionIdsJson ?? [];
        const merged = [...existingIds, ...e.payload.sessionIds];
        await db
          .update(s.marketRunsV)
          .set({
            sessionIdsJson: merged,
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
              // RE-BUY-3: a purchaser-added row becomes a demand row
              // (planned = the order's demand), as in the domain state.
              set: {
                plannedQty: sql`CASE WHEN ${s.runItemsV.addedByPurchaser} THEN ${added.qty}::numeric ELSE ${s.runItemsV.plannedQty} + ${added.qty}::numeric END`,
                addedByPurchaser: false,
                updatedAt: new Date(),
              },
            });
        }
        break;
      }

      case 'SessionEjectedFromRun': {
        const current = await db
          .select({ sessionIdsJson: s.marketRunsV.sessionIdsJson })
          .from(s.marketRunsV)
          .where(eq(s.marketRunsV.id, e.streamId))
          .limit(1);
        const existingIds = current[0]?.sessionIdsJson ?? [];
        const remainingIds = existingIds.filter((id) => id !== e.payload.sessionId);
        await db
          .update(s.marketRunsV)
          .set({
            sessionIdsJson: remainingIds,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.marketRunsV.id, e.streamId));

        for (const removed of e.payload.removedPlannedItems) {
          const existing = await db
            .select({
              plannedQty: s.runItemsV.plannedQty,
            })
            .from(s.runItemsV)
            .where(and(eq(s.runItemsV.runId, e.streamId), eq(s.runItemsV.skuId, removed.skuId)))
            .limit(1);
          // RUNAPI-05: in whole thousandths, as the reducer does.
          const remaining = qtyMilli(existing[0]?.plannedQty ?? '0') - qtyMilli(removed.qty);
          if (remaining <= 0n) {
            await db
              .delete(s.runItemStoresV)
              .where(
                and(
                  eq(s.runItemStoresV.runId, e.streamId),
                  eq(s.runItemStoresV.skuId, removed.skuId),
                ),
              );
            await db
              .delete(s.runItemsV)
              .where(
                and(eq(s.runItemsV.runId, e.streamId), eq(s.runItemsV.skuId, removed.skuId)),
              );
          } else {
            await db
              .update(s.runItemsV)
              .set({
                plannedQty: milliQty(remaining),
                updatedAt: new Date(),
              })
              .where(
                and(eq(s.runItemsV.runId, e.streamId), eq(s.runItemsV.skuId, removed.skuId)),
              );
          }
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

/**
 * Mark what was recorded for this product in this run as not the price
 * after all: the purchase was corrected or taken back. The rows stay —
 * they are what was first typed — but price readers skip them
 * (`superseded_at IS NULL`). Without this a mistyped price stayed in
 * every average for good, however quickly it was corrected.
 */
async function supersedePriceObservations(
  db: DB,
  orgId: string,
  runId: string,
  skuId: string,
  at: Date,
): Promise<void> {
  await db
    .update(s.priceHistory)
    .set({ supersededAt: at })
    .where(
      and(
        eq(s.priceHistory.orgId, orgId),
        eq(s.priceHistory.runId, runId),
        eq(s.priceHistory.skuId, skuId),
        isNull(s.priceHistory.supersededAt),
      ),
    );
}

/** The run's phase, read once for each purchase event. */
type RunPhase = { status: string; startedAt: Date | null } | undefined;

async function runPhaseOf(db: DB, runId: string): Promise<RunPhase> {
  const [run] = await db
    .select({ status: s.marketRunsV.status, startedAt: s.marketRunsV.startedAt })
    .from(s.marketRunsV)
    .where(eq(s.marketRunsV.id, runId))
    .limit(1);
  return run;
}

/**
 * RUNAPI-08 (2026-11-09): when the trip bought what a purchase event
 * records. While the run is being bought, that is now. A price written
 * after that (filled in during delivery, or corrected once the run
 * finished) is dated with the trip's last recorded purchase. Dated when
 * it was written, a price corrected weeks later became the product's
 * last price, ahead of the ones bought since: the reference the purchase
 * page offers (its one-tap ✓ saves it), the five-times check and the
 * order estimates. Only one run is bought at a time, so every later
 * trip's purchases come after this date. The run's finish time would
 * not do: a run can wait in delivery while the next one is bought.
 */
async function boughtAt(db: DB, orgId: string, e: RunEvent, run: RunPhase): Promise<Date> {
  if (!run || run.status === 'planned' || run.status === 'purchasing') return e.occurredAt;
  const [last] = await db
    .select({ observedAt: s.priceHistory.observedAt })
    .from(s.priceHistory)
    .where(and(eq(s.priceHistory.orgId, orgId), eq(s.priceHistory.runId, e.streamId)))
    .orderBy(desc(s.priceHistory.observedAt))
    .limit(1);
  const at = last?.observedAt ?? run.startedAt;
  return at && at < e.occurredAt ? at : e.occurredAt;
}

async function insertPriceObservations(
  db: DB,
  orgId: string,
  e: Extract<RunEvent, { type: 'ItemPurchased' | 'PurchaserItemAdded' | 'PurchaseRevised' }>,
  run: RunPhase,
): Promise<void> {
  // Each of these events states the whole purchase of one product in
  // one run, so whatever was observed for it before is no longer what
  // was paid.
  await supersedePriceObservations(db, orgId, e.streamId, e.payload.skuId, e.occurredAt);
  const observedAt = await boughtAt(db, orgId, e, run);
  const hasSplitOverrides = e.payload.storeSplits.some(
    (split) => split.unitPrice !== undefined || split.paymentMethod !== undefined,
  );
  if (!hasSplitOverrides) {
    await db.insert(s.priceHistory).values({
      orgId,
      skuId: e.payload.skuId,
      supplierId: e.payload.supplierId,
      runId: e.streamId,
      unitPrice: e.payload.unitPrice,
      qty: e.payload.actualQty,
      observedAt,
    });
    return;
  }
  await db.insert(s.priceHistory).values(
    e.payload.storeSplits.map((split) => ({
      orgId,
      skuId: e.payload.skuId,
      supplierId: e.payload.supplierId,
      storeId: split.storeId,
      runId: e.streamId,
      unitPrice: split.unitPrice ?? e.payload.unitPrice,
      qty: split.qty,
      observedAt,
    })),
  );
}

/**
 * R2-DLV-1 / D3 (2026-10-31). Undoing a purchase drops its split rows,
 * and with them the store's delivery, receipt and per-line verdict. While
 * a finished run is being corrected, buying the item again wrote fresh
 * rows: the store's recorded shortage vanished from history, and closing
 * the correction booked the whole allocation as received. The aggregate
 * never forgot (its per-store state survives the undo), so the rows are
 * given back what the stream says about each store up to this event:
 * delivered / confirmed, and this product's verdict if the store gave
 * one. A product new to a store that had already confirmed gets the
 * store-level fields only — it counts as received (owner decision D3)
 * and history labels it as added in a correction.
 *
 * RUNAPI-07 (2026-11-09): a revision that takes a store off the line and
 * a later one that gives it back did the same, so PurchaseRevised hands
 * over the stores whose rows it added too. `storeIds` are the stores
 * whose rows this event wrote fresh.
 *
 * Only while amending: in the normal flow nothing can be bought for a
 * store after it was delivered to, nor its quantity revised, and reading
 * the stream on every purchase would be wasted work.
 */
async function restoreAmendedVerdicts(
  db: DB,
  e: Extract<RunEvent, { type: 'ItemPurchased' | 'PurchaserItemAdded' | 'PurchaseRevised' }>,
  run: RunPhase,
  storeIds: readonly string[],
): Promise<void> {
  if (run?.status !== 'amending' || storeIds.length === 0) return;
  const rows = await db
    .select({ type: s.events.type, payload: s.events.payload, occurredAt: s.events.occurredAt })
    .from(s.events)
    .where(
      and(
        eq(s.events.streamType, 'run'),
        eq(s.events.streamId, e.streamId),
        lt(s.events.seq, e.seq),
        inArray(s.events.type, [
          'StoreDelivered',
          'StoreDeliveryUndone',
          'StoreItemConfirmed',
          'StoreConfirmed',
        ]),
      ),
    )
    .orderBy(asc(s.events.seq));
  type Verdict = {
    status: string;
    note: string | null;
    photoUrl: string | null;
    receivedQty: string | null;
  };
  type StoreState = {
    deliveredAt: Date | null;
    deliveredByUserId: string | null;
    confirmedAt: Date | null;
    confirmedByUserId: string | null;
    verdict: Verdict | null;
  };
  const stores = new Map<string, StoreState>();
  const storeOf = (storeId: string): StoreState => {
    let st = stores.get(storeId);
    if (!st) {
      st = {
        deliveredAt: null,
        deliveredByUserId: null,
        confirmedAt: null,
        confirmedByUserId: null,
        verdict: null,
      };
      stores.set(storeId, st);
    }
    return st;
  };
  for (const row of rows) {
    const p = row.payload as Record<string, unknown>;
    const st = storeOf(String(p.storeId));
    switch (row.type) {
      case 'StoreDelivered':
        st.deliveredAt = row.occurredAt;
        st.deliveredByUserId = (p.deliveredByUserId as string | undefined) ?? null;
        break;
      case 'StoreDeliveryUndone':
        st.deliveredAt = null;
        st.deliveredByUserId = null;
        st.verdict = null;
        break;
      case 'StoreItemConfirmed':
        if (p.skuId === e.payload.skuId) {
          st.verdict = {
            status: String(p.status),
            note: (p.note as string | null | undefined) ?? null,
            photoUrl: (p.photoUrl as string | null | undefined) ?? null,
            receivedQty: (p.receivedQty as string | null | undefined) ?? null,
          };
        }
        break;
      case 'StoreConfirmed':
        st.confirmedAt = row.occurredAt;
        st.confirmedByUserId = (p.confirmedByUserId as string | undefined) ?? null;
        break;
    }
  }
  for (const storeId of storeIds) {
    const st = stores.get(storeId);
    if (!st?.deliveredAt) continue;
    await db
      .update(s.runItemStoresV)
      .set({
        deliveredAt: st.deliveredAt,
        deliveredByUserId: st.deliveredByUserId,
        confirmedAt: st.confirmedAt,
        confirmedByUserId: st.confirmedByUserId,
        confirmStatus: st.verdict?.status ?? null,
        confirmNote: st.verdict?.note ?? null,
        confirmPhotoUrl: st.verdict?.photoUrl ?? null,
        confirmReceivedQty: st.verdict?.receivedQty ?? null,
      })
      .where(
        and(
          eq(s.runItemStoresV.runId, e.streamId),
          eq(s.runItemStoresV.skuId, e.payload.skuId),
          eq(s.runItemStoresV.storeId, storeId),
        ),
      );
  }
}

/**
 * DLV-3 (2026-10-30, owner decision: write offsetting movements). The
 * stock a store received is booked once, at StoreConfirmed (source 'run').
 * A super-admin correction of a finished run (undo a purchase, move a
 * split, add an item) changed the run but not the stock. When the
 * correction closes, every store that had signed gets one 'run_amend'
 * row per product: what the run now says it received minus what was
 * booked. Rewritten from scratch on each close, so a second correction or
 * a replay ends in the same rows.
 */
async function syncAmendMovements(
  db: DB,
  orgId: string,
  e: Extract<RunEvent, { type: 'RunRefinalized' }>,
): Promise<void> {
  const runId = e.streamId;
  const splits = await db
    .select({
      storeId: s.runItemStoresV.storeId,
      skuId: s.runItemStoresV.skuId,
      qty: s.runItemStoresV.qty,
      confirmStatus: s.runItemStoresV.confirmStatus,
      confirmReceivedQty: s.runItemStoresV.confirmReceivedQty,
      confirmedAt: s.runItemStoresV.confirmedAt,
    })
    .from(s.runItemStoresV)
    .where(eq(s.runItemStoresV.runId, runId));
  const booked = await db
    .select({
      storeId: s.inventoryMovements.storeId,
      skuId: s.inventoryMovements.skuId,
      delta: s.inventoryMovements.delta,
    })
    .from(s.inventoryMovements)
    .where(
      and(
        eq(s.inventoryMovements.orgId, orgId),
        eq(s.inventoryMovements.sourceType, 'run'),
        eq(s.inventoryMovements.sourceId, runId),
      ),
    );
  const signedStores = new Set(booked.map((b) => b.storeId));
  for (const sp of splits) if (sp.confirmedAt) signedStores.add(sp.storeId);
  // DX-DLV-01: what corrections added beyond each store's confirmed
  // quantity, from the stream up to this close (so a replay agrees).
  const events = (await readRunEvents(db, runId)).filter((ev) => ev.seq <= e.seq);
  const amendAdded = new Map<string, string>();
  for (const c of runCorrections(events, null)) {
    if (c.kind === 'amendAdded') amendAdded.set(`${c.storeId}|${c.skuId}`, c.qty);
  }

  // Thousandths (qty columns are numeric(12,3)), read as every quantity is.
  const key = (storeId: string, skuId: string) => `${storeId}|${skuId}`;
  const now = new Map<string, bigint>();
  for (const sp of splits) {
    if (!signedStores.has(sp.storeId)) continue;
    const k = key(sp.storeId, sp.skuId);
    now.set(k, (now.get(k) ?? 0n) + qtyMilliOrZero(receivedDelta(sp, amendAdded.get(k))));
  }
  const before = new Map<string, bigint>();
  for (const b of booked) before.set(key(b.storeId, b.skuId), qtyMilliOrZero(b.delta));

  await db
    .delete(s.inventoryMovements)
    .where(
      and(
        eq(s.inventoryMovements.orgId, orgId),
        eq(s.inventoryMovements.sourceType, 'run_amend'),
        eq(s.inventoryMovements.sourceId, runId),
      ),
    );
  const rows = [];
  for (const k of new Set([...now.keys(), ...before.keys()])) {
    const diff = (now.get(k) ?? 0n) - (before.get(k) ?? 0n);
    if (diff === 0n) continue;
    const [storeId, skuId] = k.split('|') as [string, string];
    rows.push({
      orgId,
      storeId,
      skuId,
      delta: milliQty(diff),
      reason: 'adjustment' as const,
      note: null,
      sourceType: 'run_amend' as const,
      sourceId: runId,
      actorMemberId: e.actorMemberId,
      occurredAt: e.occurredAt,
    });
  }
  if (rows.length > 0) await db.insert(s.inventoryMovements).values(rows);
}

/**
 * 2026-10-21 CA-06: inventory delta for one confirmed split. Exported
 * for unit tests. Non-ok lines with a recorded received qty book that
 * qty; everything else (ok, undecided, legacy NULL) books the split.
 */
export function receivedDelta(
  split: {
    qty: string;
    confirmStatus: string | null;
    confirmReceivedQty: string | null;
  },
  /** DX-DLV-01: quantity a correction of the finished run gave this store
   *  beyond what it confirmed (runCorrections' `amendAdded`). */
  amendAdded?: string,
): string {
  if (
    split.confirmStatus &&
    split.confirmStatus !== 'ok' &&
    split.confirmReceivedQty !== null &&
    split.confirmReceivedQty !== undefined
  ) {
    // DX-DLV-01 (2026-11-01, D3): quantity added in a correction counts as
    // received on a line the store reported a problem with too. Only the
    // received figure was booked, so the added quantity never reached
    // stock while history said "修改时补记 +2". The recorded shortfall
    // stays: received = what the store counted + what was added later.
    if (amendAdded && Number(amendAdded) > 0) {
      return milliQty(qtyMilliOrZero(split.confirmReceivedQty) + qtyMilliOrZero(amendAdded));
    }
    return split.confirmReceivedQty;
  }
  return split.qty;
}
