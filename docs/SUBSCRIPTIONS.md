# Subscriptions

Payments are intentionally deferred. This phase provides plans,
entitlements and platform-operator control so tenants can be sold and
managed manually first.

## Model

- `auth.billing_plans` — plan catalog, limits and future price fields.
- `auth.organization_subscriptions` — one row per tenant with plan,
  status, trial/period/grace dates and an internal note.
- `auth.platform_admins` — cross-tenant operators allowed to change
  subscriptions and create organisations.

Default plans:

| Code      |    Stores |    People |
| --------- | --------: | --------: |
| `starter` |         1 |        10 |
| `growth`  |         3 |        30 |
| `pro`     |        10 |       100 |
| `legacy`  | unlimited | unlimited |

New tenants start on `starter` with a 14-day trial and 7-day grace.
Existing tenants were backfilled to `legacy / active` so deployment
does not lock anyone out.

## Status and write access

Statuses:

- `trialing`
- `active`
- `past_due`
- `suspended`
- `canceled`

Business mutations require write access. Reads, login, locale changes
and platform administration remain available in read-only mode.

Write access is denied when:

- status is `suspended` or `canceled`;
- a trial or paid period has ended and its grace period has ended.

## Enforcement

- One tRPC middleware blocks every authenticated business mutation when
  `session.writeAccess` is false.
- Store creation checks the plan's store limit.
- Invite creation and invite acceptance check the people limit; the
  acceptance path checks again because the plan may have changed since
  the link was created.
- Read-only mode still allows viewing all historical data.

## Platform operator console

Admin → Platform lists every tenant with plan, status, usage and dates.
The operator can change:

- plan;
- status;
- trial end;
- paid period end;
- grace end;
- cancel-at-period-end;
- internal note.

Leaving the paid period end empty means a manual agreement with no
automatic expiry.

## Payment integration later

The price, currency and billing interval fields already exist. A later
payment adapter only needs to:

1. create an invoice/payment record;
2. update `currentPeriodStart` / `currentPeriodEnd` on success;
3. set `past_due` when a renewal fails;
4. optionally set `cancelAtPeriodEnd`.

The entitlement and read-only logic stays unchanged.
