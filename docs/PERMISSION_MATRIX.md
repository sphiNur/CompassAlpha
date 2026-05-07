# Permission Matrix

> Source of truth for what each role can do. The seed script (packages/db/src/seed-data.ts)
> mirrors this table. ABAC policy rules layered on top can grant additional or
> revoke specific permissions per scope.

## Permissions catalog

| Key | What it gates |
|---|---|
| `order.draft` | Edit own daily order draft |
| `order.submit` | Submit own draft for approval |
| `order.approve` | Approve / reject submitted orders |
| `order.claim` | Claim a submitted order for review |
| `order.unapprove` | Reverse approval (before run attaches) |
| `run.create` | Plan a market run from approved orders |
| `run.purchase` | Mark items purchased / unavailable |
| `run.eject_session` | Eject a session from a run |
| `run.finish` | Finish a run |
| `delivery.dispatch` | Mark items delivered to a store |
| `delivery.confirm` | Confirm delivery on the store side |
| `reports.view` | View daily / weekly reports |
| `reports.export` | Export reports to Excel |
| `prices.view` | View price history |
| `prices.alert.configure` | Configure price-alert thresholds |
| `inventory.skus.manage` | Manage SKUs and categories |
| `inventory.suppliers.manage` | Manage suppliers |
| `inventory.stores.manage` | Manage stores |
| `users.manage` | Manage members, roles, bindings |
| `org.settings.manage` | Manage org-level settings |
| `system.test_data.purge` | Use the test-data purge tool |
| `system.logs.view` | View system + client logs |
| `system.impersonate` | Impersonate users (super_admin only) |

## Built-in roles

| Permission | super_admin | admin | manager | purchaser | staff |
|---|:-:|:-:|:-:|:-:|:-:|
| order.draft           | ✅ | ✅ | ✅ |   | ✅ |
| order.submit          | ✅ | ✅ | ✅ |   | ✅ |
| order.approve         | ✅ | ✅ | ✅ |   |   |
| order.claim           | ✅ | ✅ | ✅ |   |   |
| order.unapprove       | ✅ | ✅ | ✅ |   |   |
| run.create            | ✅ | ✅ |   | ✅ |   |
| run.purchase          | ✅ | ✅ |   | ✅ |   |
| run.eject_session     | ✅ | ✅ |   | ✅ |   |
| run.finish            | ✅ | ✅ |   | ✅ |   |
| delivery.dispatch     | ✅ | ✅ |   | ✅ |   |
| delivery.confirm      | ✅ | ✅ |   |   | ✅ |
| reports.view          | ✅ | ✅ | ✅ |   |   |
| reports.export        | ✅ | ✅ |   |   |   |
| prices.view           | ✅ | ✅ | ✅ | ✅ |   |
| prices.alert.configure| ✅ | ✅ |   |   |   |
| inventory.skus.manage | ✅ | ✅ |   |   |   |
| inventory.suppliers.manage | ✅ | ✅ |   |   |   |
| inventory.stores.manage | ✅ | ✅ |   |   |   |
| users.manage          | ✅ | ✅ |   |   |   |
| org.settings.manage   | ✅ | ✅ |   |   |   |
| system.test_data.purge | ✅ |   |   |   |   |
| system.logs.view      | ✅ | ✅ |   |   |   |
| system.impersonate    | ✅ |   |   |   |   |

## How a check is evaluated

1. **RBAC base layer.** Resolve the user's `member_role_bindings` → roles → `role_permissions`.
   That's the candidate permission set.
2. **ABAC overlay.** Run `policy_rules` for the org × action, sorted by `priority` ascending.
   - First matching `effect = 'deny'` rule short-circuits to deny.
   - First matching `effect = 'allow'` extends the candidate set.
3. **Scope check.** If the bound role is `scopeType='store'`, the resource's `storeId` must
   match the binding's `scopeId`.
4. **Decision audit.** Every check writes a row to `domain.policy_decisions` (sampled at 10%,
   100% on deny). `system.policyDecisions(actorId)` exposes them for explainability.

## Reverse-transition rules

These are not standalone permissions — they're combinations:

- **Withdraw** — owner of the session + status ∈ `{submitted, rejected}` + not claimed.
- **Unapprove** — has `order.unapprove` + status = `approved` + session not in a run.
- **EjectFromRun** — has `run.eject_session` + the run's items are still all `pending`
  for that session's SKUs (no `ItemPurchased` / `ItemUnavailable` / `StoreDelivered` /
  `StoreItemConfirmed` referencing the session).

These guards live in `decide()` (domain-pure) — they're consistent whether the request
comes from the API, the bot, or a CLI replay.
