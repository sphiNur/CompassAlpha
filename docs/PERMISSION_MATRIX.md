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
store scope. Operating expenses follow the rest of the close (2026-10-22): whoever
has `settlement.record` effective in the store records its revenue, wages and
operating expenses; no role rank is required, so a cashier files the day's
expenses too. Total-only closes from before itemization are read-only for every
role, so a later user can never be recorded as the author of an expense that was not
originally entered as a line item.
A store-specific deny override always wins.

`sales.record` and `inventory.adjust` are checked on their own, with no
`users.manage` fallback (removed 2026-10-21, audit CA-10/CA-57). A store-specific
deny of either therefore applies to managers too, and a custom role holding only
`users.manage` can no longer record sales, stocktakes, or wastage. Migration
`0048_backfill_builtin_role_permissions.sql` backfills the three grants older
organizations never received (manager → `sales.record`, `inventory.adjust`;
staff → `sales.record`) on built-in roles only (`is_built_in = true`); it never
removes a grant, never touches custom roles, and does not re-apply any other seed
grant an admin may have removed on purpose. Sales entry is available on the Settlement page as well as Admin → Stores →
Sales, so cashiers can record sales from their only tab.

## Who may grant a role

`admin.grantRole`, and every other path that hands a role on, applies the same three rules. The other paths are:

- `admin.grantRoleInStores`, one role in several stores: each store is checked as `grantRole` checks it, and if one is refused nothing is granted;
- an invite by Telegram ID;
- an invite link;
- a transfer that mirrors roles;
- copying a store's people.

The rules live in `apps/api/src/services/adminAuthority.ts`:

- **Rank** (`grantRefusal`). The role sits strictly below the granter's rank where it applies. In a store that rank comes from their global bindings plus that store's. Globally it comes from their global bindings alone.
- **Keys** (`missingRoleKey`). A custom role carries only keys the granter holds there. Built-in roles are exempt.
- **Recipient** (`recipientRefusal`, review ADM1-08). The person receiving the role is not the granter. The granter must also stand strictly above them there:
  - in a store, the person is ranked by their global bindings plus that store's;
  - for a global role, by every binding they hold.

  Taking a role or a store away already asked this. A store manager therefore cannot make themselves a purchaser, but an admin above them can.

The workspace's super admin and platform administrators are exempt from the key and recipient rules. A suspended member is reactivated before anything is granted to them.

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
