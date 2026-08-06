# API Reference

> tRPC v11 routes mounted at `/trpc`. Inputs are Zod-validated. Errors are
> `DomainError` (i18nKey + context) wrapped in tRPC's standard envelope.

## Conventions

- Mutations may carry `Idempotency-Key` header. Same key → identical response
  for 24h.
- All authenticated requests need `Authorization: Bearer <accessToken>`.
- All error responses include `data.i18nKey`; the FE renders it via `@compass/i18n`.

## Routes

### `auth.*`

| Route                | Type     | Auth   | Notes                                                     |
| -------------------- | -------- | ------ | --------------------------------------------------------- |
| `auth.telegramLogin` | mutation | public | Verifies Telegram initData → tokens + session.            |
| `auth.me`            | query    | authed | Returns `{user, member, stores, permissions, roleSlugs}`. |
| `auth.refresh`       | mutation | public | Rotates refresh token. (M1)                               |
| `auth.signOut`       | mutation | authed | No-op for stateless access tokens; revokes refresh.       |

### `catalog.*`

| Route                   | Type  | Permission |
| ----------------------- | ----- | ---------- | -------------------------------------------------------- |
| `catalog.categories`    | query | authed     |
| `catalog.skus`          | query | authed     |
| `catalog.stores`        | query | authed     |
| `catalog.suppliers`     | query | authed     |
| `catalog.skuPriceStats` | query | authed     | M1.5 — avg-7d / last-price per SKU for budget estimates. |

### `order.*`

| Route                  | Type     | Permission        | Notes                                                         |
| ---------------------- | -------- | ----------------- | ------------------------------------------------------------- |
| `order.todaySession`   | query    | authed            | Returns owner's session for `(storeId, date)` or null.        |
| `order.sessionDetail`  | query    | authed            | Single-session view by id (any status).                       |
| `order.pendingList`    | query    | `order.approve`   | Approver queue.                                               |
| `order.adjustItem`     | mutation | `order.draft`     | Lazy-creates draft on first call.                             |
| `order.setNote`        | mutation | `order.draft`     | Per-line note.                                                |
| `order.setSessionNote` | mutation | `order.draft`     | M1.8 — session-level "其他物品" free-text.                    |
| `order.submit`         | mutation | `order.submit`    | Owner only.                                                   |
| `order.claim`          | mutation | `order.claim`     | Atomic; CONFLICT if already claimed.                          |
| `order.releaseClaim`   | mutation | `order.claim`     | Only the current claimer.                                     |
| `order.approve`        | mutation | `order.approve`   | Clears claim.                                                 |
| `order.reject`         | mutation | `order.approve`   | Reason required.                                              |
| `order.withdraw`       | mutation | owner             | Refused if claimed.                                           |
| `order.unapprove`      | mutation | `order.unapprove` | Refused if in run. M1.7-fix: clears claim (was: transferred). |

### `run.*`

Mounts at `/trpc/run.*`. All authed; specific perms documented per route.

| Route                                                          | Type     | Permission                                 | Notes                                                                                                                                               |
| -------------------------------------------------------------- | -------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.list`                                                     | query    | authed                                     | Past 50 runs, newest first.                                                                                                                         |
| `run.get`                                                      | query    | authed                                     | Full run + items + splits + per-store demand + `lastPriceBySku` + `sessionNotesByStore` (M1.8).                                                     |
| `run.history`                                                  | query    | `prices.view` in the effective store scope | Server-side search, store/date/payment filters, stable pagination, scoped totals and an all-matching-results summary.                               |
| `run.historyDetail`                                            | query    | `prices.view` in the effective store scope | Historical run detail trimmed to stores the actor may see.                                                                                          |
| `run.previewCreatable`                                         | query    | authed                                     | Org-wide preview of approved sessions for `date` (default today). Returns `plannedItems`, `perStoreDemand`, `supplierBySku`, `sessionNotesByStore`. |
| `run.create`                                                   | mutation | `run.create`                               | Spans approved sessions, emits `RunPlanned` + per-session `AttachedToRun`.                                                                          |
| `run.startPurchase` / `run.undoStartPurchase`                  | mutation | `run.purchase`                             | Stage transitions.                                                                                                                                  |
| `run.purchaseItem` / `run.revisePurchase` / `run.undoPurchase` | mutation | `run.purchase`                             | Per-SKU buy + edit + undo.                                                                                                                          |
| `run.markUnavailable` / `run.unmarkUnavailable`                | mutation | `run.purchase`                             | Per-SKU N/A toggle.                                                                                                                                 |
| `run.startDelivery` / `run.undoStartDelivery`                  | mutation | `run.purchase`                             | Stage transitions.                                                                                                                                  |
| `run.deliverToStore` / `run.undeliverStore`                    | mutation | `delivery.dispatch`                        | Per-store delivery + recall.                                                                                                                        |
| `run.confirmStoreItem` / `run.confirmStore`                    | mutation | `delivery.confirm`                         | Receiver-side per-item + final store confirm.                                                                                                       |
| `run.finish`                                                   | mutation | `run.finish`                               | Cascades `Archived` to attached sessions.                                                                                                           |
| `run.cancel`                                                   | mutation | `run.create`                               | Cancels run + ejects sessions. M1.7-fix: synthesizes `run.eject_session` perm during cascade.                                                       |
| `run.ejectSession`                                             | mutation | `run.eject_session`                        | Single session eject.                                                                                                                               |
| `run.setSkuPreferredSupplier`                                  | mutation | `inventory.suppliers.manage`               | M1.6 — per-SKU vendor pinning.                                                                                                                      |

### `settlement.*`

Daily settlement is a per-store financial ledger. Cashier/manager access is
resolved for the requested store; a permission held in one store never grants
access to another.

`settlement.save` stores explained outflows alongside its reporting totals:
each operating expense has a category, item, amount, optional recipient/vendor,
and reason; each wage row identifies the person, paid/unpaid status, amount,
and pay-period/reason. The API derives the three outflow totals from these
rows, rejects mismatches, and includes the details in every immutable revision.
Older total-only records are exposed as explicit historical rows rather than
silently changing their financial value.

| Route                     | Type                | Permission          | Notes                                                                                                                                                         |
| ------------------------- | ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settlement.businessDate` | query               | `settlement.record` | Returns the selected store's authoritative current business date and effective timezone; clients must not substitute the device date.                         |
| `settlement.get`          | query               | `settlement.record` | One store/date record or null; inactive-store history remains readable.                                                                                       |
| `settlement.recent`       | query               | `settlement.record` | Newest records for one store, with an exclusive date cursor.                                                                                                  |
| `settlement.save`         | idempotent mutation | `settlement.record` | Creates or corrects one store/date row using `expectedVersion`; corrections require a reason and atomically append a revision that normal APIs cannot update. |

### `admin.*`

All authed; broad ranks of perms (`users.manage`, `inventory.*.manage`, `org.settings.manage`).
Per-store admin scope enforced via `getActorAdminStoreIds` (C2). Selected:

- **Members**: `memberList`, `memberInviteByTgId`, `memberSetStatus`, `memberSetDisplayName`, `memberAssignStore` / `memberUnassignStore` / `memberDetachFromStore` / `memberTransferStore`, `memberRemove`, `memberPermissionsList` / `memberPermissionSet` / `memberPermissionRevoke`.
- **Roles**: `roleList`, `roleDetail`, `roleCreate`, `roleUpdate`, `roleDelete`, `permissionList`, `grantRole`, `revokeRole`.
- **Stores**: `storeList`, `storeCreate`, `storeUpdate`, `storeDelete`, `storeCloneRoles` (D4), `memberStoreAssignments`.
- **Catalog**: `categoryList/Create/Update/Delete`, `skuList/Create/Update/Delete`, `supplierList/Create/Update/Delete`.
- **Audit / overview**: `overview`, `recentEvents`, `submissionHistory`, `runList`, `sessionList`, `adminAuditList`.
- **Maintenance** (`super_admin` + `system.test_data.purge`): `purgeByDate`, `purgeAllTestData`, `purgeRun`, `purgeSession`. M1.9: gated behind `VITE_ENABLE_MAINTENANCE` build flag.

### `upload.*`

| Route                   | Type     | Auth   | Notes                                                         |
| ----------------------- | -------- | ------ | ------------------------------------------------------------- |
| `upload.config`         | query    | authed | Bucket public base + max bytes.                               |
| `upload.requestPresign` | mutation | authed | SigV4 PUT URL (M1, S3 / MinIO / R2 / Tencent COS). 5 min TTL. |

### `system.*`

| Route               | Type     | Auth   |
| ------------------- | -------- | ------ | -------------------------------------------------------------- |
| `system.health`     | query    | public |
| `system.appConfig`  | query    | public | M1.4 — Telegram bot username for invite share links.           |
| `system.log`        | mutation | public | Batched client telemetry ingest. M1.9: rate-limited 60/min/IP. |
| `system.recentLogs` | query    | authed |                                                                |

## WebSocket

`GET /ws?ticket=<short-lived-token>`

The ticket is obtained via `auth.wsTicket` (M1). Once connected, the client
subscribes to channels (`order:<sessionId>`, `run:<runId>`, `org:<orgId>`).
Server pushes `{type, payload, seq}` for each new event. Reconnect with
`?from-seq=<lastSeen>` to resume.

## Error envelope

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "order.errors.alreadyClaimed",
    "data": {
      "code": "CONFLICT",
      "domainCode": "CONFLICT",
      "i18nKey": "order.errors.alreadyClaimed",
      "context": { "claimedBy": "mem-…" }
    }
  }
}
```

The FE matches on `data.domainCode` for branching; `data.i18nKey` for display.
