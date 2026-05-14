/**
 * Notification publisher.
 *
 * Called from order/run routers right after a domain event lands. Writes
 * a row to `ops.notifications` (the in-app inbox) AND a row to
 * `sync.outbox` so the worker process can pick it up and send via
 * grammY (Telegram bot) and / or WebPush.
 *
 * The two-row pattern (notifications + outbox) lets us:
 *   - Show in-app instantly from `ops.notifications` (the projection).
 *   - Retry external delivery without losing the user-facing record.
 *   - Dedup via `notifications.dedup_key` so projection replays don't
 *     spam the user.
 *
 * Trigger points (M1):
 *   order.Submitted    → notify approvers in the org
 *   order.Approved     → notify the owner
 *   order.Rejected     → notify the owner
 *   run.RunPlanned     → notify all purchasers
 *   run.StoreDelivered → notify staff at that store
 *   run.RunFinished    → notify everyone involved
 *
 * Channel = 'bot' for now (WebPush lands later). Body is a short Markdown
 * line with a deep link back into the Mini App.
 */
import { eq, and, ne, inArray } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';

export type NotifyChannel = 'bot' | 'webpush' | 'inapp';

export interface NotifyEnvelope {
  template: string;
  title: string;
  body?: string;
  /** Deep link used by the bot send button — typically the Mini App URL. */
  deepLink?: string;
  /** Idempotency key, e.g. `order:${id}:submitted`. */
  dedupKey: string;
  payload?: Record<string, unknown>;
}

/**
 * Resolve which user IDs should be notified for the given org + permission.
 * Used to implement "notify all approvers" / "notify all purchasers" / etc.
 *
 * SCOPE NOTE (M3.6, 2026-05-15) — this returns every user in the org
 * whose role carries `permissionKey`, ignoring whether the underlying
 * member_role_binding is global or pinned to a specific store. That's
 * correct for genuinely org-wide events (RunPlanned → all purchasers
 * regardless of which stores they're bound to). For store-scoped
 * events (OrderSubmitted at Store A → notify Store A's approvers,
 * NOT Store B's), use `findRecipientsByPermissionInStore` instead.
 *
 * The bug this distinction closes: with no scope filter, a manager
 * bound to Store B (rank 60, store-tier `order.approve`) would get
 * notified about every Store A submission — info leak about another
 * store's activity.
 */
export async function findRecipientsByPermission(
  db: DB,
  orgId: string,
  permissionKey: string,
): Promise<string[]> {
  // Roles in this org that hold the permission.
  const roleRows = await db
    .select({ roleId: s.rolePermissions.roleId })
    .from(s.rolePermissions)
    .innerJoin(s.roles, eq(s.roles.id, s.rolePermissions.roleId))
    .where(
      and(eq(s.roles.orgId, orgId), eq(s.rolePermissions.permissionKey, permissionKey)),
    );
  const roleIds = [...new Set(roleRows.map((r) => r.roleId))];
  if (roleIds.length === 0) return [];

  // Members holding any of those roles.
  const memberRows = await db
    .select({ userId: s.members.userId })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .where(inArray(s.memberRoleBindings.roleId, roleIds));
  return [...new Set(memberRows.map((r) => r.userId))];
}

/**
 * Like `findRecipientsByPermission` but additionally filters by the
 * binding's store scope. Returns users whose role carries `permissionKey`
 * AND whose binding is either:
 *   - global (admin/super_admin reach everywhere), OR
 *   - store-scoped with `scope_id = storeId`
 *
 * Mirrors the pattern already in `findStoreStaff`. Used for store-
 * scoped notification fan-out so a manager-of-B never gets pinged
 * about Store A's order activity.
 */
export async function findRecipientsByPermissionInStore(
  db: DB,
  orgId: string,
  permissionKey: string,
  storeId: string,
): Promise<string[]> {
  // Roles in this org that hold the permission.
  const roleRows = await db
    .select({ roleId: s.rolePermissions.roleId })
    .from(s.rolePermissions)
    .innerJoin(s.roles, eq(s.roles.id, s.rolePermissions.roleId))
    .where(
      and(eq(s.roles.orgId, orgId), eq(s.rolePermissions.permissionKey, permissionKey)),
    );
  const roleIds = [...new Set(roleRows.map((r) => r.roleId))];
  if (roleIds.length === 0) return [];

  // Bindings of those roles, scoped to global OR our storeId.
  const bindings = await db
    .select({
      userId: s.members.userId,
      scopeType: s.memberRoleBindings.scopeType,
      scopeId: s.memberRoleBindings.scopeId,
    })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .where(
      and(
        eq(s.members.orgId, orgId),
        inArray(s.memberRoleBindings.roleId, roleIds),
      ),
    );

  const allowed = new Set<string>();
  for (const r of bindings) {
    // Global bindings reach every store (admins overseeing the chain).
    // Store-scoped bindings reach only their target store.
    if (r.scopeType === 'global' || r.scopeId === storeId) {
      allowed.add(r.userId);
    }
  }
  return [...allowed];
}

export async function findStoreStaff(db: DB, orgId: string, storeId: string): Promise<string[]> {
  // Staff = members in this org with `delivery.confirm` permission whose
  // role binding is either global or scoped to this store.
  const candidate = await findRecipientsByPermission(db, orgId, 'delivery.confirm');
  if (candidate.length === 0) return [];
  // Filter rows: keep where scope_type='global' OR scope_id matches storeId.
  // Drizzle's whereExpr is awkward for OR with NULL; do it in app code.
  const scoped = await db
    .select({
      userId: s.members.userId,
      scopeType: s.memberRoleBindings.scopeType,
      scopeId: s.memberRoleBindings.scopeId,
    })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .where(eq(s.members.orgId, orgId));
  const allowed = new Set<string>();
  for (const r of scoped) {
    if (!candidate.includes(r.userId)) continue;
    if (r.scopeType === 'global' || r.scopeId === storeId) allowed.add(r.userId);
  }
  return [...allowed];
}

/**
 * Persist a notification + outbox row per recipient. Safe to call multiple
 * times with the same `dedupKey` — `notifications.dedup_key` is UNIQUE
 * (where not null), so duplicates are silently dropped.
 */
export async function dispatch(
  db: DB,
  orgId: string,
  recipientUserIds: string[],
  envelope: NotifyEnvelope,
  channels: NotifyChannel[] = ['bot', 'inapp'],
): Promise<void> {
  if (recipientUserIds.length === 0) return;

  const notificationRows = [];
  for (const userId of recipientUserIds) {
    for (const channel of channels) {
      notificationRows.push({
        orgId,
        recipientUserId: userId,
        channel,
        template: envelope.template,
        title: envelope.title,
        body: envelope.body ?? null,
        payload: envelope.payload ?? {},
        deepLink: envelope.deepLink ?? null,
        dedupKey: `${envelope.dedupKey}:${userId}:${channel}`,
      });
    }
  }
  // Bulk insert; per-row dedup_key conflicts are ignored.
  await db.insert(s.notifications).values(notificationRows).onConflictDoNothing();

  // Outbox rows are NOT keyed by dedup; they're transient queue entries.
  // The worker consumes them and marks `sent_at`.
  await db.insert(s.outbox).values(
    notificationRows
      .filter((r) => r.channel !== 'inapp')
      .map((r) => ({
        aggregate: 'notification',
        aggregateId: orgId, // shard key
        eventId: orgId, // unused; worker reads payload
        channel: r.channel,
        payload: {
          orgId,
          recipientUserId: r.recipientUserId,
          template: r.template,
          title: r.title,
          body: r.body ?? '',
          deepLink: r.deepLink ?? '',
          dedupKey: r.dedupKey,
          extra: r.payload,
        },
      })),
  );
}

/**
 * Convenience: notify everyone in the org with a permission, EXCEPT
 * the actor themselves (we don't tell people about their own actions).
 *
 * Pass `options.storeId` to additionally constrain by the binding's
 * store scope. Callers handling a store-scoped event (e.g., order
 * submitted at a specific store) MUST pass storeId — otherwise the
 * recipient set is org-wide and managers of other stores leak into
 * the notification (M3.6 fix).
 */
export async function notifyOthersWithPermission(
  db: DB,
  orgId: string,
  permissionKey: string,
  excludeUserId: string | null,
  envelope: NotifyEnvelope,
  options?: { storeId?: string },
): Promise<void> {
  const all = options?.storeId
    ? await findRecipientsByPermissionInStore(db, orgId, permissionKey, options.storeId)
    : await findRecipientsByPermission(db, orgId, permissionKey);
  const targets = excludeUserId ? all.filter((u) => u !== excludeUserId) : all;
  await dispatch(db, orgId, targets, envelope);
}

// Re-export for routers that just need the type without pulling in the impl.
export type { DB };
// Suppress unused-import warning in some TS configs.
void ne;
