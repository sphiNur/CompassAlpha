/**
 * Built-in role names, role descriptions and permission descriptions in
 * the UI language (ADM-17 / RE-AUTH-2, 2026-10-31).
 *
 * The database keeps what the seed wrote — English ("Store Manager",
 * "Confirm a delivery on store side") — and the admin screens printed it
 * as is in every language, while Settings › About already translated the
 * role. The stored values stay (other clients and the audit log read
 * them); only the display goes through the catalog:
 *
 *   - a built-in role whose name / description is still the seeded one
 *     shows `settings.about.roleName.<slug>` / `role.description.<slug>`;
 *     an admin who renamed a built-in role sees their own name;
 *   - a permission shows `permission.<key>`, falling back to the stored
 *     description for a key the catalog does not know yet;
 *   - permission groups show `permission.group.<prefix>`.
 */
import type { I18n } from '@compass/i18n';

type T = I18n['t'];
type Key = Parameters<T>[0];

/**
 * The seeded English values (packages/db/src/seed-data.ts BUILTIN_ROLES).
 * roleLabels.test.ts compares the two so they cannot drift apart.
 */
export const BUILTIN_ROLE_DEFAULTS: Record<string, { name: string; description: string }> = {
  super_admin: {
    name: 'Super Admin',
    description: 'Full access including impersonation and test-data purge',
  },
  admin: { name: 'Admin', description: 'Org-level configuration without impersonation' },
  manager: {
    name: 'Store Manager',
    description: 'Approves orders, views reports, and manages staff for their stores',
  },
  purchaser: { name: 'Purchaser', description: 'Runs market trips' },
  cashier: {
    name: 'Cashier',
    description: 'Records store sales and completes the daily settlement',
  },
  staff: { name: 'Store Staff', description: 'Drafts and submits daily order; confirms deliveries' },
};

/** `t(key)` when the catalog has the key, else `fallback`. */
function known(t: T, key: string, fallback: string): string {
  const v = t(key as Key);
  return v === key ? fallback : v;
}

export function roleLabeller(t: T) {
  return {
    /** A role's name; a bare slug (session.roleSlugs) works too. */
    name(role: { slug: string; name?: string | null }): string {
      const def = BUILTIN_ROLE_DEFAULTS[role.slug];
      const stored = role.name ?? undefined;
      if (def && (stored === undefined || stored === def.name)) {
        return known(t, `settings.about.roleName.${role.slug}`, stored ?? role.slug);
      }
      return stored ?? role.slug;
    },
    description(role: { slug: string; description: string | null }): string | null {
      const def = BUILTIN_ROLE_DEFAULTS[role.slug];
      if (def && role.description === def.description) {
        return known(t, `role.description.${role.slug}`, role.description);
      }
      return role.description;
    },
    permission(key: string, stored: string | null): string {
      return known(t, `permission.${key}`, stored ?? key);
    },
    permissionGroup(prefix: string): string {
      return known(t, `permission.group.${prefix}`, prefix);
    },
  };
}
