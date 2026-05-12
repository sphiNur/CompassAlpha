/**
 * Static permission catalog + built-in role definitions.
 * Imported by both the seed script and the policy engine for default checks.
 */
export type PermissionDef = { key: string; description: string };

export const PERMISSIONS = [
  { key: 'order.draft', description: 'Create or edit own order draft' },
  { key: 'order.submit', description: 'Submit own draft for approval' },
  { key: 'order.approve', description: 'Approve or reject submitted orders' },
  { key: 'order.claim', description: 'Claim a submitted order for review' },
  { key: 'order.unapprove', description: 'Reverse approval (before run)' },

  { key: 'run.create', description: 'Plan a market run from approved orders' },
  { key: 'run.purchase', description: 'Mark items purchased / unavailable' },
  { key: 'run.eject_session', description: 'Eject a session from a run' },
  { key: 'run.finish', description: 'Finish a run' },

  { key: 'delivery.dispatch', description: 'Mark items delivered to a store' },
  { key: 'delivery.confirm', description: 'Confirm a delivery on store side' },

  { key: 'reports.view', description: 'View daily/weekly reports' },
  { key: 'reports.export', description: 'Export reports to Excel' },

  { key: 'prices.view', description: 'View price history' },
  { key: 'prices.alert.configure', description: 'Configure price alert thresholds' },

  { key: 'inventory.skus.manage', description: 'Manage SKUs and categories' },
  { key: 'inventory.suppliers.manage', description: 'Manage suppliers' },
  { key: 'inventory.stores.manage', description: 'Manage stores' },
  // M2.0a (2026-05-08): manual inventory adjustments (stocktake +
  // wastage). Per-store scoped — a store manager has this for THEIR
  // store(s) only; admins and super_admins get it implicitly via
  // users.manage. Delivery-receive auto-emissions on StoreConfirmed
  // are NOT gated by this permission — they're a side effect of the
  // existing delivery.confirm authority.
  { key: 'inventory.adjust', description: 'Stocktake / wastage corrections' },

  { key: 'users.manage', description: 'Manage members, roles, and bindings' },
  // Granular split of users.manage (added 2026-05-03). Servers
  // accept either the granular key OR the legacy users.manage; new
  // custom roles can use the finer keys to allow e.g. "manager can
  // assign staff to my store but cannot grant manager+".
  { key: 'users.grant_role', description: 'Grant a role to a member (rank-gated)' },
  { key: 'users.revoke_role', description: 'Revoke a role from a member' },
  { key: 'users.assign_store', description: 'Assign a member to a store' },
  { key: 'org.settings.manage', description: 'Manage org-level settings' },
  { key: 'system.test_data.purge', description: 'Use the test-data purge tool' },
  { key: 'system.logs.view', description: 'View system + client logs' },
  { key: 'system.impersonate', description: 'Impersonate other users (super_admin)' },
] as const satisfies readonly PermissionDef[];

export const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const BUILTIN_ROLES = [
  {
    slug: 'super_admin',
    name: 'Super Admin',
    description: 'Full access including impersonation and test-data purge',
    rank: 100,
    permissions: ALL_PERMISSION_KEYS as readonly string[],
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Org-level configuration without impersonation',
    rank: 80,
    permissions: ALL_PERMISSION_KEYS.filter(
      (k) => k !== 'system.impersonate' && k !== 'system.test_data.purge',
    ) as readonly string[],
  },
  {
    slug: 'manager',
    name: 'Store Manager',
    description: 'Approves orders, views reports, and manages staff for their stores',
    rank: 60,
    permissions: [
      'order.draft',
      'order.submit',
      'order.approve',
      'order.claim',
      'order.unapprove',
      'reports.view',
      'prices.view',
      // 2026-05-07: store managers must be able to invite + assign staff
      // for their own store(s). The cross-store gates in
      // admin.ts (`getActorAdminStoreIds`) already prevent them from
      // touching members of stores they don't manage; this perm just
      // unlocks the entry point.
      'users.manage',
      // M2.0a (2026-05-08): manage stocktake + wastage for their stores.
      'inventory.adjust',
    ] as readonly string[],
  },
  {
    slug: 'purchaser',
    name: 'Purchaser',
    description: 'Runs market trips',
    rank: 40,
    permissions: [
      'run.create',
      'run.purchase',
      'run.eject_session',
      'run.finish',
      'delivery.dispatch',
      'prices.view',
    ] as readonly string[],
  },
  {
    slug: 'staff',
    name: 'Store Staff',
    description: 'Drafts and submits daily order; confirms deliveries',
    rank: 20,
    permissions: [
      'order.draft',
      'order.submit',
      'delivery.confirm',
    ] as readonly string[],
  },
] as const;
