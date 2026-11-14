# Event Catalog

> Every event the system writes to `domain.events`. Its readers are the
> reducers in `packages/domain`, the projectors in `packages/streams` and
> `apps/api/src/services/runProjection.ts`, the worker, and the Fine app,
> which reads the same database. `packages/domain/src/eventCatalog.test.ts`
> fails when an event type is missing here or listed here but gone.

## The contract

- **Events are never rewritten.** A trigger refuses UPDATE / DELETE /
  TRUNCATE on `domain.events`; only a maintenance purge may remove rows
  (`allowEventPurge`).
- **Optional additions.** A payload may gain an optional field, and an enum
  a new value, when every reader handles the field's absence and the
  unknown value. The tables give each such field's meaning on older events
  and the date it arrived.
- **Anything else is a new type.** Changing what a field means, or making
  a field required, needs a new type (e.g. `ItemAdjustedV2`) and a
  projector branch for both.

## Conventions

- Stream id formats: ULID for both `order` and `run`.
- `seq` starts at 1 and increases by exactly 1 per event in a stream.
- `(streamId, seq)` is UNIQUE in `domain.events` — that's our optimistic
  concurrency primitive.
- `correlationId` groups events caused by the same client command.
- `causationId` points to the event that triggered this one (cross-stream
  workflows: e.g. `Approved` causes `AttachedToRun` later).
- Quantities and money are decimal strings. An optional field marked
  "absent before X" is missing on every event written before that date.

## Streams

### `order` stream

One stream per store and order date (`packages/domain/src/order/events.ts`).

| Type | Payload | Notes |
|---|---|---|
| `DraftStarted` | `{orgId, storeId, initiatedByMemberId, orderDate}` | Always seq=1. Lazily created on first `AdjustItem`. M1.4 renamed `memberId` → `initiatedByMemberId`. |
| `ItemAdjusted` | `{skuId, qty, prevQty, byMemberId, forMemberId}` | Per-(sku, contributor) row since M1.5. `byMemberId` is the actor; `forMemberId` is whose row is mutated (manager-edit-via-targetMemberId differs from `byMemberId`). |
| `ItemNoteSet` | `{skuId, note: string \| null, byMemberId, forMemberId}` | Same actor/contributor split as `ItemAdjusted`. |
| `SessionNoteSet` | `{note: string \| null, byMemberId}` | M1.8 — session-level free text for things not in the catalog. No skuId. Locked once status leaves `draft`/`rejected`. 1000-char domain cap. |
| `SessionExtrasSet` | `{extras: {name, qty, unit, note?, status?}[], byMemberId}` | M3.16-C (2026-05-16) — the structured "other items" list; each event carries the full list. `status` (`'pending' \| 'bought' \| 'unavailable'`): absent before M3.37 (2026-05-19) and on rows never marked = `'pending'`. |
| `ExtraStatusSet` | `{extraIndex, status: 'pending' \| 'bought' \| 'unavailable', byMemberId}` | M3.37 (2026-05-19) — the purchaser marks one "other items" row during a run. |
| `Submitted` | `{itemCount, byMemberId}` | Owner only. Requires ≥ 1 non-zero aggregate item. |
| `Claimed` | `{byMemberId}` | Atomic: collision throws CONFLICT. |
| `ClaimReleased` | `{byMemberId, reason: 'manual' \| 'pagehide' \| 'override', fromMemberId?}` or `{byMemberId: null, reason: 'timeout'}` | `override` (2026-05-18): another approver took over; `byMemberId` is the one taking over. `fromMemberId`: whose claim an override ended; absent before 2026-10-30 and on self-releases. `timeout` (M3.20, 2026-05-18): the worker, no actor. |
| `Approved` | `{byMemberId}` | Clears claim. |
| `Rejected` | `{byMemberId, reason}` | Clears claim. Reason required. |
| `Withdrawn` | `{byMemberId}` | Owner OR `order.approve` (manager). Refused if claimed. |
| `Unapproved` | `{byMemberId, reason?}` | Refused if already in run. M1.7-fix: now CLEARS the claim (was: transferred to unapprover). |
| `AttachedToRun` | `{runId}` | |
| `EjectedFromRun` | `{runId, byMemberId, reason?}` or `{runId, byMemberId: null, reason: 'repair'}` | Refused if anything in the run is purchased/delivered/confirmed. The `null` form (2026-10-21, CA-45) comes from the worker's repair of a session left `in_run` on a cancelled run. |
| `Archived` | `{reason: 'eod' \| 'manual' \| 'run_finished' \| 'repair' \| 'empty_draft'}` | Terminal — no further events. `run_finished` (2026-05-03): cascaded from `RunFinished`. `repair` (2026-10-21, CA-45): the worker's repair of a session left `in_run` on a finished run. `empty_draft` (2026-10-30, RE-ORD-5): a draft its author emptied, so it stops holding the day's one open draft. |

### `run` stream

One stream per purchasing trip (`packages/domain/src/run/events.ts`). A store
split is `{storeId, qty, unitPrice?, paymentMethod?}`; the two optional fields
(2026-06-22) override the line's price and payment method for that store and
are absent when the store pays the line's.

| Type | Payload | Notes |
|---|---|---|
| `RunPlanned` | `{orgId, runDate, runIndex, sessionIds[], plannedItems[{skuId, qty}], purchaserMemberId}` | Always seq=1. `runIndex` numbers the day's runs from 0. |
| `PurchaseStarted` | `{}` | The first `PurchaseItem` / `AddPurchaserItem` on a planned run emits it too. |
| `ItemPurchased` | `{skuId, supplierId \| null, unitPrice, actualQty, receiptPhotoUrl \| null, storeSplits[], paymentMethod?, priceConfirmed?}` | Sum of split qtys must equal actualQty. `paymentMethod` (`'cash' \| 'transfer'`): absent before M1.14 (2026-05-08) = `'cash'`. `priceConfirmed: true`: the purchaser confirmed a price 5× away from the last one paid; absent otherwise and before 2026-10-21. |
| `ItemUnavailable` | `{skuId, note}` | |
| `DeliveryStarted` | `{}` | All items must be purchased or unavailable, with no open top-up. |
| `StoreDelivered` | `{storeId, deliveredByUserId}` | |
| `StoreItemConfirmed` | `{storeId, skuId, status: 'ok' \| 'short' \| 'wrong' \| 'quality', note, photoUrl, receivedQty?}` | Note required for 'wrong' and 'quality'; optional (null) for 'short' and 'ok' (C2, 2026-11-13). `receivedQty`: how much of the split arrived usable; absent on `ok` and before 2026-10-21 (CA-06) = the full split. |
| `StoreConfirmed` | `{storeId, confirmedByUserId}` | All purchased items at this store must have a `StoreItemConfirmed` (since 2026-10-30, DLV-19, none is implied). |
| `RunFinished` | `{totalActual, totalCash?, totalTransfer?, itemsTotal?, expensesTotal?}` | All involved stores must be confirmed. `totalActual` is items only. `totalCash` / `totalTransfer`: absent before M1.14 (2026-05-08) = all cash. `itemsTotal` (= `totalActual`) / `expensesTotal`: absent before 2026-10-21 (CA-11); recompute from the read model. |
| `RunCancelled` | `{reason: string \| null}` | `null` since M1.7 (2026-05-07): left blank. |
| `RunReopened` | `{reason, byMemberId}` | 2026-07-06, `run.amend`: finished → amending. |
| `RunDateChanged` | `{runDate, previousRunDate: string \| null, runIndex?, byMemberId}` | 2026-07-30, `run.amend`: the day the run's spend is booked under. `runIndex`: the run's number on the new day; absent before 2026-10-23 = the number was kept. |
| `RunRefinalized` | `{totalActual, totalCash, totalTransfer, itemsTotal?, expensesTotal?, byMemberId}` | 2026-07-06: amending → finished, totals recomputed as in `RunFinished`. `itemsTotal` / `expensesTotal`: absent before 2026-10-21. |
| `PurchaseRevised` | `{skuId, supplierId \| null, unitPrice, actualQty, receiptPhotoUrl \| null, storeSplits[], reason, paymentMethod?, priceConfirmed?}` | 2026-05-03: replaces the item's recorded purchase. `paymentMethod` / `priceConfirmed`: as in `ItemPurchased`. |
| `UnavailableUndone` | `{skuId, reason}` | 2026-05-03: an unavailable item back to pending. `reason` is `''` when none was given (optional since 2026-11-13). |
| `TopUpDismissed` | `{skuId, qty, note}` | 2026-10-30 (BUY-5): the extra demand that arrived after the item was decided will not be bought. Since 2026-11-13 (RUNAPI-12) the top-up is projected: `run_items_v.top_up_qty`, current while `market_runs_v.top_up_seq` = `last_seq`. |
| `PurchaseUndone` | `{skuId, reason}` | 2026-05-03: a bought item back to pending. `reason` may be `''` since 2026-05-04. |
| `StoreDeliveryUndone` | `{storeId, reason}` | 2026-05-03: recalls a delivery the store has not confirmed. `reason` is `''` when none was given (optional since 2026-11-13). |
| `PurchaseStartUndone` | `{reason}` | 2026-05-03: purchasing → planned. Recorded purchases stay (M3.29). `reason` is `''` when none was given (optional since 2026-11-13). |
| `DeliveryStartUndone` | `{reason}` | 2026-05-03: delivering → purchasing, only before any store is delivered. `reason` is `''` when none was given (optional since 2026-11-13). |
| `SessionsAttachedToRun` | `{sessionIds[], addedPlannedItems[{skuId, qty}]}` | M3.31 (2026-05-18), planned or purchasing. Demand for an item already decided becomes its top-up. |
| `SessionEjectedFromRun` | `{sessionId, removedPlannedItems[{skuId, qty}], reason: string \| null, byMemberId}` | The session's stream gets `EjectedFromRun` in the same transaction. Only pending items may shrink. |
| `PurchaserItemAdded` | `{skuId, supplierId \| null, unitPrice, actualQty, receiptPhotoUrl \| null, storeSplits[], paymentMethod, reason, byMemberId, priceConfirmed?}` | M3.41 (2026-05-21): a catalog item nobody ordered. `priceConfirmed`: as in `ItemPurchased`. |
| `RunExpenseAdded` | `{expenseId, label, unitHint \| null, qty, unitPrice, storeSplits[{storeId, qty}], paymentMethod, receiptPhotoUrl \| null, reason, byMemberId}` | M3.44 (2026-05-22): a cost outside the catalog. `expenseId` is generated by the client; a repeat is ignored. |
| `RunExpenseRemoved` | `{expenseId, reason, byMemberId}` | M3.44: while the run is open, or reopened for correction. |
| `RunClaimed` | `{byMemberId}` | M3.38 (2026-05-19). |
| `RunClaimReleased` | `{byMemberId, reason: 'manual' \| 'pagehide' \| 'override'}` or `{byMemberId: null, reason: 'timeout'}` | M3.38. `override`: another purchaser took over; `timeout`: the worker, no actor. |

## How to add a new event

1. Add the TS type in `packages/domain/src/<stream>/events.ts`.
2. Extend the union and `apply()` in `state.ts`.
3. Add a `decide()` branch in `commands.ts` that throws `validation`,
   `forbidden`, `conflict`, or `preconditionFailed` for invalid inputs.
4. Add a projector branch: `packages/streams/src/orderProjection.ts` for an
   order event, `apps/api/src/services/runProjection.ts` for a run event.
5. Add a row to this catalog and the type to `eventCatalog.test.ts`.
6. Add unit tests for the new decision branches in `<stream>.test.ts`.
7. Bump no schema; events are JSON in `domain.events.payload` so the column
   already accepts the new shape.

## Snapshot policy

Snapshots (`domain.snapshots`) are written every 200 events on the same
stream by the worker. Replay starts from the last snapshot, then catches up
through `events` after that snapshot's seq.

Replay must be deterministic — `decide()` is pure, so given identical
events the resulting state is identical. CI runs the "drop+rebuild yields
identical view" test on every commit.
