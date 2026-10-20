# Multi-tenancy

## Definition

An **organisation** is the tenant. Stores, people, roles, catalog,
orders, runs, reports and settings all belong to exactly one
organisation. One deployment serves many organisations; one Telegram
identity may belong to several.

## Isolation model

PostgreSQL Row-Level Security is the backstop:

- org-owned tables carry `org_id`;
- child tables without `org_id` are isolated through their parent row;
- every authenticated request runs inside a transaction with
  `app.current_org_id` set by `withOrgContext`;
- tenant-less access is refused unless the code explicitly opens a
  `withSystemContext` transaction for auth, worker, health, telemetry
  or maintenance.

The current probe/test suites cover RLS isolation and the deploy checks
that the application DB role is not `BYPASSRLS`.

## Session model

An access token contains:

- `sub` — user id;
- `org` — selected organisation;
- `mid` — membership id in that organisation.

Every session payload contains the user's active `memberships` so the
client can render a workspace switcher without a second tenant-discovery
endpoint.

Refresh tokens now also carry `org` and `mid`. A refresh stays in the
same tenant. Tokens issued before this change have no tenant claims and
fall back to `users.last_org_id`, then to an active membership for
backward compatibility.

## Flows

### Login

1. Verify Telegram `initData`.
2. Resolve the user's `last_org_id`; use it only when an active
   membership still exists.
3. Otherwise select an active membership.
4. Return a session for that tenant plus every active membership.

### Switch workspace

`auth.switchOrganization({ orgId })`:

1. Require the current access token.
2. Verify the caller has an active membership in the target tenant.
3. Record `users.last_org_id`.
4. Issue a new access + refresh token pair bound to the target tenant.
5. The client clears its query cache before rendering the new workspace,
   so no cached row from the previous tenant can flash.

### Create workspace

`auth.createOrganization` is a platform-operator path. It requires an
authenticated session plus a row in `auth.platform_admins`; being the
`super_admin` or highest admin of one organisation is not enough.

1. Verify the caller is a platform administrator.
2. Create the organisation.
3. Provision the permission catalog, built-in role ladder, default
   feature flags and workflow.
4. Create the owner membership and a global `admin` binding.
5. Issue a session for the new tenant.

Grant platform access with:

```bash
compass platform grant <tgUserId>
compass platform list
```

The provisioning helper is also used by `compass org create --owner`
for operator-created tenants outside the app.

### Invitation

`admin.memberInviteCreate` creates a one-time, expiring, hashed token.
Accepting it verifies Telegram identity, creates or reuses the user,
creates the membership in the invited tenant, applies the snapshotted
store/role grants, and returns a session for that tenant.

## Deliberate limits

Not included in this phase:

- payment collection (plans and entitlement enforcement are implemented;
  see `docs/SUBSCRIPTIONS.md`);
- subdomain-per-tenant routing;
- a cross-tenant platform-admin console;
- per-tenant encryption keys;
- importing an existing tenant's catalog into a newly created one.

These can be added without changing the tenant key (`organisations.id`)
or the RLS boundary.

## Operational notes

- Migration `0042_user_last_org` adds `auth.users.last_org_id`.
- Existing users remain valid; their first login after deploy picks an
  active membership and records it as the last workspace.
- A new workspace starts with the built-in roles but no stores. Its owner
  can create the first store from Admin → Stores.
- The stable public HTTPS entry is
  `https://compass-alpha.sphinxr.workers.dev` (Cloudflare Worker). It proxies
  through the server's supervised quick tunnel, so no owned domain is needed.
  A server-side timer publishes a changed tunnel hostname within one minute;
  the public URL stays the same and needs no manual refresh.
