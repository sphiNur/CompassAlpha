/**
 * The admin audit. Every admin action writes one `policy_decisions` row
 * (auditAdmin) with the names of what it touched as they were then; the
 * audit list reads the rows back with today's names (auditRowRefs,
 * loadAuditLookups, buildAuditLabels) and falls back to those.
 *
 * Review ADM1-11 (2026-11-12): moved here from the admin router.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import { bindingIsLive } from './adminAuthority';
import { logger } from '../infra/log';

/**
 * Audit log helper for admin CRUD (added 2026-05-05).
 *
 * The order/run domains write to `domain.events` for every state change,
 * so "who edited yesterday" is queryable there. But catalog mutations
 * (SKU/category/store/supplier) wrote to inventory tables ONLY — no
 * audit trail. The pre-launch audit flagged this as a gap: an admin
 * could rename "Beef" to "Toilet paper" and there's no record.
 *
 * Cheapest fix: write a row to `domain.policy_decisions` after every
 * successful catalog mutation, with `decision='allow'` and the input
 * payload as `inputs`. The table was added in 0000 for ABAC tracing
 * but never populated; reusing it here gives admins a queryable
 * history without a new schema migration.
 *
 * Best-effort: if the audit insert throws, we log and continue —
 * the catalog change has already committed. Better to keep a
 * functional system than to roll back over an audit hiccup.
 */
/**
 * Best-effort audit row writer. `tx` is the per-request drizzle
 * transaction (whose full generic type is too hairy to inline cleanly);
 * we accept it loosely-typed and rely on the single typed insert call
 * below for safety. If the insert throws (e.g. the table is RLS-locked
 * mid-deploy), we swallow and continue — losing an audit row is
 * preferable to losing the catalog write that already committed.
 */
/**
 * B2 (2026-05-06): derive a store id from action input so the audit
 * row can be indexed by store and the FE can filter by it.
 *
 * The keys we look at, in priority order:
 *   - storeId            — most catalog/member-store ops
 *   - scopeId + scopeType==='store' — grantRole / memberPermissionSet
 *   - toStoreId          — memberTransferStore (the destination is
 *                          the most "in scope" — that's where the
 *                          new state lives). The from-side stays in the
 *                          inputs JSON and adminAuditList matches it too,
 *                          so admins of either store see the transfer.
 *                          (2026-10-21: this used to look for a
 *                          `targetStoreId` key the transfer never sends,
 *                          leaving every transfer row unscoped.)
 *   - targetStoreId      — legacy key, still honoured
 *   - storeIds[0]        — multi-store ops (invite). The first id is
 *                          the conventional "primary" target for
 *                          single-store filtering. Audit row's `inputs`
 *                          still has the full list for cross-checks.
 *
 * Returns null when none of those resolve to a UUID — global ops like
 * `admin.role.create` legitimately have no store scope.
 */
export function deriveScopeStoreId(
  _action: string,
  resourceType: string,
  inputs: unknown,
): string | null {
  // resourceType='store' implies the action targets a store directly.
  if (resourceType === 'store') {
    const o = inputs as Record<string, unknown> | null;
    if (o && typeof o === 'object') {
      const sid =
        (typeof o.storeId === 'string' ? o.storeId : null) ??
        (typeof o.targetStoreId === 'string' ? o.targetStoreId : null);
      if (sid) return sid;
    }
  }
  if (!inputs || typeof inputs !== 'object') return null;
  const o = inputs as Record<string, unknown>;
  if (typeof o.storeId === 'string') return o.storeId;
  if (typeof o.scopeType === 'string' && o.scopeType === 'store' && typeof o.scopeId === 'string') {
    return o.scopeId;
  }
  if (typeof o.toStoreId === 'string') return o.toStoreId;
  if (typeof o.targetStoreId === 'string') return o.targetStoreId;
  if (Array.isArray(o.storeIds) && o.storeIds.length === 1 && typeof o.storeIds[0] === 'string') {
    return o.storeIds[0];
  }
  if (
    Array.isArray(o.memberStoreIds) &&
    o.memberStoreIds.length === 1 &&
    typeof o.memberStoreIds[0] === 'string'
  ) {
    return o.memberStoreIds[0];
  }
  return null;
}

/**
 * ADM-13 (2026-10-30): the stores a member belongs to (assignments and
 * store-scoped roles). Suspend / reactivate / rename carry only a memberId,
 * so their audit rows had no store and the store manager who did them
 * could not find them in their own audit log.
 */
export async function memberStoreIdsForAudit(tx: DB, memberId: string): Promise<string[]> {
  const [assigned, bound] = await Promise.all([
    tx
      .select({ storeId: s.memberStoreAssignments.storeId })
      .from(s.memberStoreAssignments)
      .where(eq(s.memberStoreAssignments.memberId, memberId)),
    tx
      .select({ storeId: s.memberRoleBindings.scopeId })
      .from(s.memberRoleBindings)
      .where(
        and(
          eq(s.memberRoleBindings.memberId, memberId),
          eq(s.memberRoleBindings.scopeType, 'store'),
          bindingIsLive(),
        ),
      ),
  ]);
  const ids = new Set<string>();
  for (const row of [...assigned, ...bound]) if (row.storeId) ids.add(row.storeId);
  return [...ids];
}

/** ADM2-06: a role's name for an audit change line (null for none). */
export async function roleNameForAudit(tx: DB, roleId: string | null): Promise<string | null> {
  if (!roleId) return null;
  const [row] = await tx.select({ name: s.roles.name }).from(s.roles).where(eq(s.roles.id, roleId));
  return row?.name ?? null;
}

/** ADM2-06: a category's names map for an audit change line (null for none). */
export async function categoryNamesForAudit(
  tx: DB,
  categoryId: string | null,
): Promise<Record<string, string> | null> {
  if (!categoryId) return null;
  const [row] = await tx
    .select({ names: s.categories.names })
    .from(s.categories)
    .where(eq(s.categories.id, categoryId));
  return (row?.names as Record<string, string> | undefined) ?? null;
}

/** Audit rows scoped to any of `storeIds`, including a transfer's from-store. */
export function auditTouchesStores(storeIds: string[]) {
  const list = sql.join(
    storeIds.map((id) => sql`${id}`),
    sql`, `,
  );
  return or(
    inArray(s.policyDecisions.scopeStoreId, storeIds),
    sql`(${s.policyDecisions.inputs} ->> 'fromStoreId') in (${list})`,
    // ADM-13: member actions list every store the member was in.
    sql`jsonb_exists_any(${s.policyDecisions.inputs} -> 'memberStoreIds', array[${list}]::text[])`,
    // ADM2-05: rows about several stores (a purged run, a multi-store
    // invite) list them all; scope_store_id holds one store at most.
    sql`jsonb_exists_any(${s.policyDecisions.inputs} -> 'storeIds', array[${list}]::text[])`,
  );
}

export async function auditAdmin(
  tx: DB,
  ctx: { session?: { userId: string; orgId: string } | null },
  action: string,
  resourceType: string,
  resourceId: string | null,
  inputs: unknown,
  /**
   * ADM2-05 (2026-11-09): `strict` rolls the action back with the audit
   * row, as the daily settlement does. A purge cannot be undone, so it is
   * not done unrecorded; elsewhere the action stands and the failure is
   * logged.
   */
  options: { strict?: boolean } = {},
): Promise<void> {
  try {
    // B19 (2026-10-30): inside a savepoint. In Postgres a failed statement
    // aborts the whole transaction, so catching the error here was not
    // "best effort" — the admin action itself then failed. A nested
    // transaction rolls back only this insert.
    await tx.transaction(async (sp) => {
      const scopeStoreId = deriveScopeStoreId(action, resourceType, inputs);
      // R2-ADM-3 (2026-10-31): the list resolves names when it is read,
      // so a role deleted or a member removed since showed as "(unknown)".
      // Keep the names as they are now; the list falls back to them.
      const refs = auditRowRefs({ resourceType, resourceId, inputs, scopeStoreId });
      const labels = buildAuditLabels(refs, await loadAuditLookups(sp, ctx.session!.orgId, [refs]));
      const snapshot = Object.fromEntries(Object.entries(labels).filter(([, v]) => v !== null));
      const withSnapshot =
        inputs &&
        typeof inputs === 'object' &&
        !Array.isArray(inputs) &&
        Object.keys(snapshot).length
          ? { ...(inputs as Record<string, unknown>), [AUDIT_LABELS_KEY]: snapshot }
          : inputs;
      await sp.insert(s.policyDecisions).values({
        orgId: ctx.session!.orgId,
        actorId: ctx.session!.userId,
        action,
        resourceType,
        resourceId,
        decision: 'allow',
        inputs: withSnapshot as Record<string, unknown>,
        scopeStoreId,
      });
    });
  } catch (err) {
    logger.warn({ err, action }, 'admin audit insert failed');
    if (options.strict) throw err;
  }
}

/**
 * 2026-10-21 FE-08 (F6-02): the audit list only carried ids, so "who
 * granted what role to whom" was unanswerable for anyone but a
 * super_admin reading raw inputs. `auditRowRefs` picks the ids a row
 * talks about (pure — unit-tested); adminAuditList batch-resolves them
 * in the same transaction and `buildAuditLabels` turns them into names.
 * Every lookup tolerates a missing target (removed member, deleted
 * role): that label is simply null and the client falls back.
 */
export interface AuditRowRefs {
  memberId: string | null;
  /** inputs.userId — survives member removal, so it's the fallback. */
  userId: string | null;
  roleSlug: string | null;
  roleId: string | null;
  storeId: string | null;
  toStoreId: string | null;
  catalog: { kind: 'sku' | 'category' | 'supplier' | 'expenseTemplate'; id: string } | null;
}

export interface AuditRowLabels {
  memberName: string | null;
  roleName: string | null;
  /** Lets the client show a built-in role's name in the UI language. */
  roleSlug: string | null;
  storeName: string | null;
  toStoreName: string | null;
  /** Supplier / expense-template label (single string). */
  targetName: string | null;
  /** SKU / category i18n names map. */
  targetNames: Record<string, string> | null;
}

export interface AuditLookups {
  memberNameById: Map<string, string>;
  userNameById: Map<string, string>;
  roleNameBySlug: Map<string, string>;
  roleNameById: Map<string, string>;
  roleSlugById: Map<string, string>;
  storeNameById: Map<string, string>;
  catalogNameById: Map<string, string>;
  catalogNamesById: Map<string, Record<string, string>>;
}

const CATALOG_RESOURCE_TYPES = new Set(['sku', 'category', 'supplier', 'expenseTemplate']);

function str(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function auditRowRefs(row: {
  resourceType: string | null;
  resourceId: string | null;
  inputs: unknown;
  scopeStoreId: string | null;
}): AuditRowRefs {
  const o =
    row.inputs && typeof row.inputs === 'object' ? (row.inputs as Record<string, unknown>) : {};
  const rt = row.resourceType ?? '';
  const rid = row.resourceId;
  const memberId =
    (rt === 'member' || rt === 'permission') && rid ? rid : (str(o, 'memberId') ?? null);
  const storeIds = Array.isArray(o.storeIds)
    ? o.storeIds.filter((x): x is string => typeof x === 'string')
    : [];
  const scopedStore = str(o, 'scopeType') === 'store' ? (str(o, 'scopeId') ?? null) : null;
  const storeId =
    (rt === 'store' ? rid : null) ??
    str(o, 'storeId') ??
    str(o, 'fromStoreId') ??
    scopedStore ??
    (storeIds.length === 1 ? storeIds[0]! : null) ??
    row.scopeStoreId;
  return {
    memberId,
    userId: str(o, 'userId'),
    roleSlug: str(o, 'roleSlug'),
    // A grant from the command line (`compass user grant`) names its
    // role by id only.
    roleId: rt === 'role' && rid ? rid : str(o, 'roleId'),
    storeId,
    toStoreId: str(o, 'toStoreId') ?? (rt === 'store' ? null : str(o, 'targetStoreId')),
    catalog:
      CATALOG_RESOURCE_TYPES.has(rt) && rid
        ? { kind: rt as NonNullable<AuditRowRefs['catalog']>['kind'], id: rid }
        : null,
  };
}

/** inputs key holding the names as they were when the row was written. */
export const AUDIT_LABELS_KEY = 'labelsAtWrite';

/** R2-ADM-3: the write-time names stored on a row, if any. */
export function auditLabelsAtWrite(inputs: unknown): Partial<AuditRowLabels> {
  if (!inputs || typeof inputs !== 'object') return {};
  const v = (inputs as Record<string, unknown>)[AUDIT_LABELS_KEY];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<AuditRowLabels>) : {};
}

export function buildAuditLabels(
  refs: AuditRowRefs,
  l: AuditLookups,
  atWrite: Partial<AuditRowLabels> = {},
): AuditRowLabels {
  const get = (m: Map<string, string>, k: string | null) => (k ? (m.get(k) ?? null) : null);
  const text = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  return {
    memberName:
      get(l.memberNameById, refs.memberId) ??
      get(l.userNameById, refs.userId) ??
      text(atWrite.memberName),
    roleName:
      get(l.roleNameBySlug, refs.roleSlug) ??
      get(l.roleNameById, refs.roleId) ??
      text(atWrite.roleName),
    roleSlug: refs.roleSlug ?? get(l.roleSlugById, refs.roleId) ?? text(atWrite.roleSlug),
    storeName: get(l.storeNameById, refs.storeId) ?? text(atWrite.storeName),
    toStoreName: get(l.storeNameById, refs.toStoreId) ?? text(atWrite.toStoreName),
    targetName:
      (refs.catalog ? get(l.catalogNameById, refs.catalog.id) : null) ?? text(atWrite.targetName),
    targetNames:
      (refs.catalog ? (l.catalogNamesById.get(refs.catalog.id) ?? null) : null) ??
      (atWrite.targetNames && typeof atWrite.targetNames === 'object' ? atWrite.targetNames : null),
  };
}

export async function loadAuditLookups(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  orgId: string,
  refs: AuditRowRefs[],
): Promise<AuditLookups> {
  const uniq = (xs: (string | null | undefined)[]) => [
    ...new Set(xs.filter((x): x is string => !!x)),
  ];
  // Every id is user-controlled JSON from `inputs`; drop non-UUIDs so a
  // malformed historical row can't make the uuid cast throw.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = (xs: (string | null | undefined)[]) => uniq(xs).filter((x) => UUID.test(x));
  const memberIds = ids(refs.map((r) => r.memberId));
  const userIds = ids(refs.map((r) => r.userId));
  const roleSlugs = uniq(refs.map((r) => r.roleSlug));
  const roleIds = ids(refs.map((r) => r.roleId));
  const storeIds = ids(refs.flatMap((r) => [r.storeId, r.toStoreId]));
  const catalogIds = (kind: string) =>
    ids(refs.map((r) => (r.catalog?.kind === kind ? r.catalog.id : null)));
  const skuIds = catalogIds('sku');
  const categoryIds = catalogIds('category');
  const supplierIds = catalogIds('supplier');
  const templateIds = catalogIds('expenseTemplate');

  const [members, users, rolesBySlug, rolesById, stores, skus, categories, suppliers, templates] =
    await Promise.all([
      memberIds.length
        ? tx
            .select({ id: s.members.id, name: s.users.displayName })
            .from(s.members)
            .innerJoin(s.users, eq(s.users.id, s.members.userId))
            .where(and(eq(s.members.orgId, orgId), inArray(s.members.id, memberIds)))
        : [],
      userIds.length
        ? tx
            .select({ id: s.users.id, name: s.users.displayName })
            .from(s.users)
            .where(inArray(s.users.id, userIds))
        : [],
      roleSlugs.length
        ? tx
            .select({ slug: s.roles.slug, name: s.roles.name })
            .from(s.roles)
            .where(and(eq(s.roles.orgId, orgId), inArray(s.roles.slug, roleSlugs)))
        : [],
      roleIds.length
        ? tx
            .select({ id: s.roles.id, name: s.roles.name, slug: s.roles.slug })
            .from(s.roles)
            .where(and(eq(s.roles.orgId, orgId), inArray(s.roles.id, roleIds)))
        : [],
      // Soft-deleted stores are included on purpose: "archived store X"
      // must still name X.
      storeIds.length
        ? tx
            .select({ id: s.stores.id, name: s.stores.name })
            .from(s.stores)
            .where(and(eq(s.stores.orgId, orgId), inArray(s.stores.id, storeIds)))
        : [],
      skuIds.length
        ? tx
            .select({ id: s.skus.id, names: s.skus.names })
            .from(s.skus)
            .where(and(eq(s.skus.orgId, orgId), inArray(s.skus.id, skuIds)))
        : [],
      categoryIds.length
        ? tx
            .select({ id: s.categories.id, names: s.categories.names })
            .from(s.categories)
            .where(and(eq(s.categories.orgId, orgId), inArray(s.categories.id, categoryIds)))
        : [],
      supplierIds.length
        ? tx
            .select({ id: s.suppliers.id, name: s.suppliers.name })
            .from(s.suppliers)
            .where(and(eq(s.suppliers.orgId, orgId), inArray(s.suppliers.id, supplierIds)))
        : [],
      templateIds.length
        ? tx
            .select({ id: s.expenseTemplates.id, name: s.expenseTemplates.label })
            .from(s.expenseTemplates)
            .where(
              and(eq(s.expenseTemplates.orgId, orgId), inArray(s.expenseTemplates.id, templateIds)),
            )
        : [],
    ]);
  const byId = (rows: { id: string; name: string | null }[]) =>
    new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name as string]));
  return {
    memberNameById: byId(members),
    userNameById: byId(users),
    roleNameBySlug: new Map(
      (rolesBySlug as { slug: string; name: string }[]).map((r) => [r.slug, r.name]),
    ),
    roleNameById: byId(rolesById),
    roleSlugById: new Map((rolesById as { id: string; slug: string }[]).map((r) => [r.id, r.slug])),
    storeNameById: byId(stores),
    catalogNameById: byId([...suppliers, ...templates]),
    catalogNamesById: new Map(
      ([...skus, ...categories] as { id: string; names: unknown }[])
        .filter((r) => r.names && typeof r.names === 'object')
        .map((r) => [r.id, r.names as Record<string, string>]),
    ),
  };
}
