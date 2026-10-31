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
import { eq, and, ne, inArray, or, isNull, gt } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import { detectLocale, format, loadCatalog, lookup, type CatalogKey, type Locale } from '@compass/i18n';

export type NotifyChannel = 'bot' | 'webpush' | 'inapp';

export interface NotifyEnvelope {
  template: string;
  /**
   * English fallback. R2 (2026-10-31): each recipient gets the catalog's
   * `notify.<template>.title` / `.body` in their own language, filled from
   * `vars`; these strings are only used for a template the catalog lacks.
   */
  title: string;
  body?: string;
  /** Values for the catalog sentence ({store}, {n}, {total} …). */
  vars?: Record<string, string | number>;
  /**
   * A reason the actor typed (reject / unapprove / cancel). It replaces
   * the catalog body as is — it is the person's own words.
   */
  reason?: string | null;
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
  const bindings = await activeBindingsWithPermission(db, orgId, permissionKey);
  const denied = await deniedMemberIds(db, bindings, permissionKey, null);
  return [...new Set(bindings.filter((b) => !denied.has(b.memberId)).map((b) => b.userId))];
}

/**
 * Like `findRecipientsByPermission` but additionally filters by the
 * binding's store scope. Returns users whose role carries `permissionKey`
 * AND whose binding is either:
 *   - global (admin/super_admin reach everywhere), OR
 *   - store-scoped with `scope_id = storeId`
 *
 * Used for store-scoped notification fan-out so a manager-of-B never
 * gets pinged about Store A's order activity.
 */
export async function findRecipientsByPermissionInStore(
  db: DB,
  orgId: string,
  permissionKey: string,
  storeId: string,
): Promise<string[]> {
  // Global bindings reach every store (admins overseeing the chain).
  // Store-scoped bindings reach only their target store.
  const bindings = (await activeBindingsWithPermission(db, orgId, permissionKey)).filter(
    (b) => b.scopeType === 'global' || b.scopeId === storeId,
  );
  const denied = await deniedMemberIds(db, bindings, permissionKey, storeId);
  return [...new Set(bindings.filter((b) => !denied.has(b.memberId)).map((b) => b.userId))];
}

export async function findStoreStaff(db: DB, orgId: string, storeId: string): Promise<string[]> {
  // Staff = members in this org with `delivery.confirm` through a binding
  // that is global or scoped to this store. 2026-10-21 audit CA-31: this
  // used to accept a user whose delivery.confirm came from a Store-B
  // binding as long as ANY of their bindings was global; now the binding
  // that carries the permission must itself reach the store.
  return findRecipientsByPermissionInStore(db, orgId, 'delivery.confirm', storeId);
}

interface PermissionBinding {
  memberId: string;
  userId: string;
  scopeType: string;
  scopeId: string | null;
}

/**
 * Role bindings in `orgId` that carry `permissionKey`, for members who can
 * still sign in. 2026-10-21 audit CA-31/F-07: the recipient queries did not
 * look at members.status or binding expiry, so suspended members and
 * expired temporary roles kept receiving store activity over Telegram.
 * Same filters as the session loader (trpc/context.ts readSession).
 */
async function activeBindingsWithPermission(
  db: DB,
  orgId: string,
  permissionKey: string,
): Promise<PermissionBinding[]> {
  return db
    .select({
      memberId: s.members.id,
      userId: s.members.userId,
      scopeType: s.memberRoleBindings.scopeType,
      scopeId: s.memberRoleBindings.scopeId,
    })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .innerJoin(s.rolePermissions, eq(s.rolePermissions.roleId, s.roles.id))
    .where(
      and(
        eq(s.roles.orgId, orgId),
        eq(s.members.orgId, orgId),
        eq(s.members.status, 'active'),
        eq(s.rolePermissions.permissionKey, permissionKey),
        or(
          isNull(s.memberRoleBindings.expiresAt),
          gt(s.memberRoleBindings.expiresAt, new Date()),
        ),
      ),
    );
}

/**
 * Members with an active deny override for `permissionKey`: global ones
 * always, store ones only when `storeId` is that store. Deny wins over the
 * role grant, as in storeScope.effectivePermissionsForStore. Allow
 * overrides are not consulted (they never removed anyone from a list).
 */
async function deniedMemberIds(
  db: DB,
  bindings: PermissionBinding[],
  permissionKey: string,
  storeId: string | null,
): Promise<Set<string>> {
  const memberIds = [...new Set(bindings.map((b) => b.memberId))];
  if (memberIds.length === 0) return new Set();
  const rows = await db
    .select({ memberId: s.memberPermissionOverrides.memberId })
    .from(s.memberPermissionOverrides)
    .where(
      and(
        inArray(s.memberPermissionOverrides.memberId, memberIds),
        eq(s.memberPermissionOverrides.permissionKey, permissionKey),
        eq(s.memberPermissionOverrides.effect, 'deny'),
        storeId
          ? or(
              eq(s.memberPermissionOverrides.scopeType, 'global'),
              and(
                eq(s.memberPermissionOverrides.scopeType, 'store'),
                eq(s.memberPermissionOverrides.scopeId, storeId),
              ),
            )
          : eq(s.memberPermissionOverrides.scopeType, 'global'),
        or(
          isNull(s.memberPermissionOverrides.expiresAt),
          gt(s.memberPermissionOverrides.expiresAt, new Date()),
        ),
      ),
    );
  return new Set(rows.map((r) => r.memberId));
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

  const locales = await recipientLocales(db, orgId, recipientUserIds);
  const notificationRows = [];
  for (const userId of recipientUserIds) {
    const text = await localizeEnvelope(envelope, locales.get(userId) ?? 'en');
    for (const channel of channels) {
      notificationRows.push({
        orgId,
        recipientUserId: userId,
        channel,
        template: envelope.template,
        title: text.title,
        body: text.body ?? null,
        payload: envelope.payload ?? {},
        deepLink: envelope.deepLink ?? null,
        dedupKey: `${envelope.dedupKey}:${userId}:${channel}`,
      });
    }
  }
  // Bulk insert; per-row dedup_key conflicts are ignored.
  // 2026-10-21 audit CA-31/F-04: RETURNING tells us which rows were new.
  // The outbox used to be written for every row, so a dedup'd repeat was
  // silent in the inbox but sent again over Telegram.
  const inserted = await db
    .insert(s.notifications)
    .values(notificationRows)
    .onConflictDoNothing()
    .returning({ dedupKey: s.notifications.dedupKey });
  const fresh = new Set(inserted.map((r) => r.dedupKey));

  // Outbox rows are transient queue entries, written only for the
  // notifications that were actually inserted above.
  // The worker consumes them and marks `sent_at`.
  const outboxRows = notificationRows.filter((r) => r.channel !== 'inapp' && fresh.has(r.dedupKey));
  if (outboxRows.length === 0) return;
  await db.insert(s.outbox).values(
    outboxRows
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

/**
 * Each recipient's UI language: their own setting, else the org default.
 * Notifications used to go out in English to everyone (APR-16, DLV-5).
 */
async function recipientLocales(
  db: DB,
  orgId: string,
  userIds: string[],
): Promise<Map<string, Locale>> {
  const [users, org] = await Promise.all([
    db
      .select({ id: s.users.id, locale: s.users.locale })
      .from(s.users)
      .where(inArray(s.users.id, userIds)),
    db.query.organizations.findFirst({
      where: (o, { eq: eq2 }) => eq2(o.id, orgId),
      columns: { localeDefault: true },
    }),
  ]);
  const fallback = detectLocale(org?.localeDefault);
  return new Map(users.map((u) => [u.id, u.locale ? detectLocale(u.locale) : fallback]));
}

/** The envelope's title and body in `locale`, from `notify.<template>.*`. */
export async function localizeEnvelope(
  envelope: Pick<NotifyEnvelope, 'template' | 'title' | 'body' | 'vars' | 'reason'>,
  locale: Locale,
): Promise<{ title: string; body: string | undefined }> {
  await loadCatalog(locale);
  const titleKey = `notify.${envelope.template}.title` as CatalogKey;
  const bodyKey = `notify.${envelope.template}.body` as CatalogKey;
  const vars = envelope.vars ?? {};
  const title = lookup(titleKey, locale) ? format(titleKey, locale, vars) : envelope.title;
  const body = envelope.reason
    ? envelope.reason
    : lookup(bodyKey, locale)
      ? format(bodyKey, locale, vars)
      : envelope.body;
  return { title, body };
}
