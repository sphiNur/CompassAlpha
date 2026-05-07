# Event Catalog

> Authoritative list of every event the system can emit. Append-only — to
> change a payload you must add a new TYPE (e.g. `ItemAdjustedV2`) and update
> the projector to handle both. Never mutate an existing payload schema.

## Conventions

- Stream id formats: ULID for both `order` and `run`.
- `seq` starts at 1 and increases by exactly 1 per event in a stream.
- `(streamId, seq)` is UNIQUE in `domain.events` — that's our optimistic
  concurrency primitive.
- `correlationId` groups events caused by the same client command.
- `causationId` points to the event that triggered this one (cross-stream
  workflows: e.g. `Approved` causes `AttachedToRun` later).

## Streams

### `order` stream

| Type | Payload | Notes |
|---|---|---|
| `DraftStarted` | `{orgId, storeId, initiatedByMemberId, orderDate}` | Always seq=1. Lazily created on first `AdjustItem`. M1.4 renamed `memberId` → `initiatedByMemberId`. |
| `ItemAdjusted` | `{skuId, qty, prevQty, byMemberId, forMemberId}` | Per-(sku, contributor) row since M1.5. `byMemberId` is the actor; `forMemberId` is whose row is mutated (manager-edit-via-targetMemberId differs from `byMemberId`). |
| `ItemNoteSet` | `{skuId, note: string \| null, byMemberId, forMemberId}` | Same actor/contributor split as `ItemAdjusted`. |
| `SessionNoteSet` | `{note: string \| null, byMemberId}` | M1.8 — session-level "其他物品" free-text. No skuId. Locked once status leaves `draft`/`rejected`. 1000-char domain cap. |
| `Submitted` | `{itemCount, byMemberId}` | Owner only. Requires ≥ 1 non-zero aggregate item. |
| `Claimed` | `{byMemberId}` | Atomic: collision throws CONFLICT. |
| `ClaimReleased` | `{byMemberId, reason: 'manual'\|'pagehide'\|'timeout'}` | Only the current claimer. |
| `Approved` | `{byMemberId}` | Clears claim. |
| `Rejected` | `{byMemberId, reason}` | Clears claim. Reason required. |
| `Withdrawn` | `{byMemberId}` | Owner OR `order.approve` (manager). Refused if claimed. |
| `Unapproved` | `{byMemberId, reason?}` | Refused if already in run. M1.7-fix: now CLEARS the claim (was: transferred to unapprover). |
| `AttachedToRun` | `{runId}` | |
| `EjectedFromRun` | `{runId, byMemberId, reason?}` | Refused if anything in the run is purchased/delivered/confirmed. |
| `Archived` | `{reason: 'eod'\|'manual'\|'run_finished'}` | Terminal — no further events. `run_finished` cascaded from `RunFinished` (M1.5). |

### `run` stream

| Type | Payload | Notes |
|---|---|---|
| `RunPlanned` | `{orgId, runDate, runIndex, sessionIds[], plannedItems[], purchaserMemberId}` | Always seq=1. |
| `PurchaseStarted` | `{}` | First `PurchaseItem` auto-emits this. |
| `ItemPurchased` | `{skuId, supplierId\|null, unitPrice, actualQty, receiptPhotoUrl\|null, storeSplits[]}` | Sum of split qtys must equal actualQty. |
| `ItemUnavailable` | `{skuId, note}` | |
| `DeliveryStarted` | `{}` | All items must be purchased or unavailable. |
| `StoreDelivered` | `{storeId, deliveredByUserId}` | |
| `StoreItemConfirmed` | `{storeId, skuId, status: 'ok'\|'short'\|'wrong'\|'quality', note, photoUrl}` | Note required when status ≠ 'ok'. |
| `StoreConfirmed` | `{storeId, confirmedByUserId}` | All purchased items at this store must have a `StoreItemConfirmed`. |
| `RunFinished` | `{totalActual}` | All involved stores must be confirmed. |
| `RunCancelled` | `{reason}` | |

## How to add a new event

1. Add the TS type in `packages/domain/src/<stream>/events.ts`.
2. Extend the union and `apply()` in `state.ts`.
3. Add a `decide()` branch in `commands.ts` that throws `validation`,
   `forbidden`, `conflict`, or `preconditionFailed` for invalid inputs.
4. Add a projector branch in `apps/api/src/services/<stream>Projection.ts`.
5. Update this catalog.
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
