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

| Route | Type | Auth | Notes |
|---|---|---|---|
| `auth.telegramLogin` | mutation | public | Verifies Telegram initData → tokens + session. |
| `auth.me` | query | authed | Returns `{user, member, stores, permissions, roleSlugs}`. |
| `auth.refresh` | mutation | public | Rotates refresh token. (M1) |
| `auth.signOut` | mutation | authed | No-op for stateless access tokens; revokes refresh. |

### `catalog.*`

| Route | Type | Permission |
|---|---|---|
| `catalog.categories` | query | authed |
| `catalog.skus` | query | authed |
| `catalog.stores` | query | authed |
| `catalog.suppliers` | query | authed |

### `order.*`

| Route | Type | Permission | Notes |
|---|---|---|---|
| `order.todaySession` | query | authed | Returns owner's session for `(storeId, date)` or null. |
| `order.pendingList` | query | `order.approve` | Approver queue. |
| `order.adjustItem` | mutation | `order.draft` | Lazy-creates draft on first call. |
| `order.setNote` | mutation | `order.draft` | |
| `order.submit` | mutation | `order.submit` | Owner only. |
| `order.claim` | mutation | `order.claim` | Atomic; CONFLICT if already claimed. |
| `order.releaseClaim` | mutation | `order.claim` | Only the current claimer. |
| `order.approve` | mutation | `order.approve` | Clears claim. |
| `order.reject` | mutation | `order.approve` | Reason required. |
| `order.withdraw` | mutation | owner | Refused if claimed. |
| `order.unapprove` | mutation | `order.unapprove` | Refused if in run. |

### `system.*`

| Route | Type | Auth |
|---|---|---|
| `system.health` | query | public |
| `system.log` | mutation | public | Batched client telemetry ingest. |
| `system.recentLogs` | query | authed | |

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
