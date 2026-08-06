# Permission Matrix

> Source of truth for what each role can do. The seed script (packages/db/src/seed-data.ts)
> mirrors this table. ABAC policy rules layered on top can grant additional or
> revoke specific permissions per scope.

## Permissions catalog

| Key                          | What it gates                                           |
| ---------------------------- | ------------------------------------------------------- |
| `order.draft`                | Edit own daily order draft                              |
| `order.submit`               | Submit own draft for approval                           |
| `order.approve`              | Approve / reject submitted orders                       |
| `order.claim`                | Claim a submitted order for review                      |
| `order.unapprove`            | Reverse approval (before run attaches)                  |
| `run.create`                 | Plan a market run from approved orders                  |
| `run.create.org`             | Plan a market run across all stores in the organization |
| `run.purchase`               | Mark items purchased / unavailable                      |
| `run.eject_session`          | Eject a session from a run                              |
| `run.finish`                 | Finish a run                                            |
| `run.amend`                  | Reopen and correct a finished run                       |
| `delivery.dispatch`          | Mark items delivered to a store                         |
| `delivery.confirm`           | Confirm delivery on the store side                      |
| `reports.view`               | View daily / weekly reports                             |
| `reports.export`             | Export reports to Excel                                 |
| `prices.view`                | View price history                                      |
| `prices.alert.configure`     | Configure price-alert thresholds                        |
| `inventory.skus.manage`      | Manage SKUs and categories                              |
| `inventory.suppliers.manage` | Manage suppliers                                        |
| `inventory.stores.manage`    | Manage stores                                           |
| `inventory.adjust`           | Record stocktakes and wastage corrections               |
| `dishes.manage`              | Manage dishes and recipes/BOM                           |
| `sales.record`               | Record store sales                                      |
| `settlement.record`          | Record and review a store's daily settlement            |
| `users.manage`               | Manage members, roles, bindings                         |
| `users.grant_role`           | Grant lower-ranked roles                                |
| `users.revoke_role`          | Revoke roles                                            |
| `users.assign_store`         | Assign members to stores                                |
| `org.settings.manage`        | Manage org-level settings                               |
| `org.admin`                  | Organization-wide administrative authority              |
| `system.test_data.purge`     | Use the test-data purge tool                            |
| `system.logs.view`           | View system + client logs                               |
| `system.impersonate`         | Impersonate users (super_admin only)                    |

## Built-in roles

| Permission                 | super_admin | admin | manager | purchaser | cashier | staff |
| -------------------------- | :---------: | :---: | :-----: | :-------: | :-----: | :---: |
| order.draft                |     ✅      |  ✅   |   ✅    |           |         |  ✅   |
| order.submit               |     ✅      |  ✅   |   ✅    |           |         |  ✅   |
| order.approve              |     ✅      |  ✅   |   ✅    |           |         |       |
| order.claim                |     ✅      |  ✅   |   ✅    |           |         |       |
| order.unapprove            |     ✅      |  ✅   |   ✅    |           |         |       |
| run.create                 |     ✅      |  ✅   |         |    ✅     |         |       |
| run.create.org             |     ✅      |  ✅   |         |           |         |       |
| run.purchase               |     ✅      |  ✅   |         |    ✅     |         |       |
| run.eject_session          |     ✅      |  ✅   |         |    ✅     |         |       |
| run.finish                 |     ✅      |  ✅   |         |    ✅     |         |       |
| run.amend                  |     ✅      |       |         |           |         |       |
| delivery.dispatch          |     ✅      |  ✅   |         |    ✅     |         |       |
| delivery.confirm           |     ✅      |  ✅   |         |           |         |  ✅   |
| reports.view               |     ✅      |  ✅   |   ✅    |           |         |       |
| reports.export             |     ✅      |  ✅   |         |           |         |       |
| prices.view                |     ✅      |  ✅   |   ✅    |    ✅     |         |       |
| prices.alert.configure     |     ✅      |  ✅   |         |           |         |       |
| inventory.skus.manage      |     ✅      |  ✅   |         |           |         |       |
| inventory.suppliers.manage |     ✅      |  ✅   |         |           |         |       |
| inventory.stores.manage    |     ✅      |  ✅   |         |           |         |       |
| inventory.adjust           |     ✅      |  ✅   |   ✅    |           |         |       |
| dishes.manage              |     ✅      |  ✅   |         |           |         |       |
| sales.record               |     ✅      |  ✅   |   ✅    |           |   ✅    |  ✅   |
| settlement.record          |     ✅      |  ✅   |   ✅    |           |   ✅    |       |
| users.manage               |     ✅      |  ✅   |   ✅    |           |         |       |
| users.grant_role           |     ✅      |  ✅   |         |           |         |       |
| users.revoke_role          |     ✅      |  ✅   |         |           |         |       |
| users.assign_store         |     ✅      |  ✅   |         |           |         |       |
| org.settings.manage        |     ✅      |  ✅   |         |           |         |       |
| org.admin                  |     ✅      |  ✅   |         |           |         |       |
| system.test_data.purge     |     ✅      |       |         |           |         |       |
| system.logs.view           |     ✅      |  ✅   |         |           |         |       |
| system.impersonate         |     ✅      |       |         |           |         |       |

The cashier role is intentionally separate from general staff: cashiers can
record sales and daily settlement only for stores covered by their role binding.
Managers and organization administrators can also settle within their effective
store scope. Operating-expense detail is a stricter store-level action: its
server-side gate requires an effective role rank of at least manager (60), or a
persisted global `org.admin` grant. A cashier may record revenue and
selected-person wages but cannot add, edit, or remove daily operating expenses.
Total-only closes from before itemization are read-only for every role, so a
later user can never be recorded as the author of an expense that was not
originally entered as a line item.
A store-specific deny override always wins.

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
