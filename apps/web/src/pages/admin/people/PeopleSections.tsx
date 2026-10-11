/**
 * Admin → People & Permissions — extracted verbatim from AdminPage.tsx
 * (Phase 5 step 4, FRONTEND_AUDIT_2026-07.md admin split).
 *
 *   - PeopleSection          member directory (also mounted by the
 *                            store Team tab in admin/stores)
 *   - PermissionsSection     role list + RoleAssigneesByStore
 *   - Role / invite / manage / transfer / member-permission sheets +
 *     ScopeTab + GrantRoleSheet (internal)
 *
 * The audit's PermissionMatrix consolidation (3 hand-rolled matrices)
 * lands on top of this split as its own pass.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Checkbox,
  DataState,
  EmptyState,
  Field,
  Input,
  ListRow,
  SectionLabel,
  Segmented,
  Select,
  Sheet,
  Spinner,
  useToast,
} from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts';
import { STALE } from '../../../config/timings';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { matchesAnyString, normalizeQuery } from '../../../lib/searchMatch';
import { useDateFormat, useI18n } from '../../../hooks/useI18n';
import { getTg } from '../../../hooks/useTelegram';
import { useStoreContext } from '../../../components/StoreSwitcher';
import { botLink as makeBotLink, shareLink as makeShareLink } from '../../../lib/telegramLinks';
import { nativeConfirm } from '../shared';
import {
  Button as KitButton,
  Field as KitField,
  Sheet as KitSheet,
  StatusChip,
} from '@compass/ui/kit';
import { ChevronIcon, ClockIcon, PlusIcon, SearchIcon } from '../../../destinations/icons';

// ============ People ============

interface InviteDraft {
  tgUserId: string;
  displayName: string;
  roleSlug: string;
  /** At least one store must be picked unless the role is admin/super_admin
   *  (which auto-bypass via users.manage permission). */
  storeIds: string[];
}

/**
 * PeopleSection — directory of org members.
 *
 * Two callers, two behaviors:
 *
 *   - **No `lockMode` (legacy)**: honor the global StoreSwitcher.
 *     `specific` → filter to that store. `all` → grouped view with
 *     "Org-level" header. `none` → unreachable. (Kept for any caller
 *     that still wires this — currently none after M1.4.)
 *
 *   - **`lockMode={ kind: 'store', storeId }`** (M1.4 default): only
 *     show members assigned to this specific store. The StoreSwitcher
 *     is bypassed entirely — this screen lives inside StoreDetailScreen,
 *     so the parent already establishes the store context.
 *
 *   - **`lockMode={ kind: 'org-level' }`** (M1.4): show only members
 *     with no store assignments (admin / super_admin org-level
 *     operators). Used by the Stores → Org-level pseudo-store entry.
 */
/** One choice among several, as a capsule; the chosen one filled dark. */
const capsule = (on: boolean) =>
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70 disabled:opacity-40 ' +
  (on ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink');

export function PeopleSection({
  lockMode,
}: {
  lockMode?: { kind: 'store'; storeId: string } | { kind: 'org-level' };
} = {}) {
  const session = useAuthStore((s) => s.session);
  const membersQuery = trpc.admin.memberList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const dateFmt = useDateFormat();
  // M1.9: per-key allow/deny override grid is power-user surface — gate
  // the "Permissions" button to global admins only. The 4 built-in
  // roles cover the common cases that store-scoped managers need.
  // Managing every store currently visible in a session is not the same as
  // organization-wide authority (a single-store manager satisfies that old
  // test). Permission overrides are global-impact tooling, so gate them on
  // the explicit organization marker.
  const isGlobalAdminPeople = session?.permissions.includes('org.admin') ?? false;
  // Resolve the effective storeCtx. When `lockMode` is set we bypass
  // the global StoreSwitcher; otherwise we fall back to it for the
  // legacy unscoped path.
  const fallbackCtx = useStoreContext();
  const storeCtx =
    lockMode?.kind === 'store'
      ? { kind: 'specific' as const, storeId: lockMode.storeId }
      : lockMode?.kind === 'org-level'
        ? { kind: 'org-level' as const }
        : fallbackCtx;
  // Note: the previous internal tabs (Members | Roles) are gone — Roles
  // & Permissions is now its own top-level sub-section under People.
  // This screen is purely the members directory.
  const [grantFor, setGrantFor] = useState<{
    userId: string;
    displayName: string;
    defaultStoreId?: string | null;
  } | null>(null);
  const [manageFor, setManageFor] = useState<{
    memberId: string;
    userId: string;
    displayName: string;
  } | null>(null);
  // Member-permission overrides editor target (added 2026-05-05).
  // Tap "Permissions" button on a member card → opens
  // MemberPermissionsSheet with the role-derived baseline grayed out
  // and explicit allow/deny rows toggleable.
  //
  // 2026-05-06: now also carries `stores` for the per-store override
  // tabs (A2). Pulled from the member-list row at click time so the
  // sheet doesn't need a second query for them.
  const [permsFor, setPermsFor] = useState<{
    memberId: string;
    displayName: string;
    stores: Array<{ id: string; name: string }>;
  } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState<InviteDraft | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const setStatus = trpc.admin.memberSetStatus.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.info(i18n.t('admin.toast.memberUpdated'));
    },
    onError: errToast('common.error'),
  });
  const remove = trpc.admin.memberRemove.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.success(i18n.t('admin.toast.memberRemoved'));
    },
    onError: errToast('common.error'),
  });
  const revoke = trpc.admin.revokeRole.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.info(i18n.t('admin.toast.roleRevoked'));
    },
    onError: errToast('common.error'),
  });
  // D1 (2026-05-06): one-shot detach. Server atomically deletes the
  // MSA row + revokes any store-scoped role bindings + drops store-
  // scoped permission overrides for that store. Their assignments
  // and bindings in OTHER stores are untouched.
  const detachFromStore = trpc.admin.memberDetachFromStore.useMutation({
    onSuccess: (data) => {
      void utils.admin.memberList.invalidate();
      const parts = [i18n.t('people.toastRemovedFromStore')];
      if (data.revokedBindings > 0)
        parts.push(i18n.t('people.toastRolesRevoked', { n: data.revokedBindings }));
      if (data.revokedOverrides > 0)
        parts.push(i18n.t('people.toastOverridesDropped', { n: data.revokedOverrides }));
      toast.info(parts.join(' · '));
    },
    onError: errToast('common.error'),
  });
  const invite = trpc.admin.memberInviteByTgId.useMutation({
    onSuccess: (data) => {
      void utils.admin.memberList.invalidate();
      toast[data.created ? 'success' : 'info'](
        data.created ? i18n.t('admin.toast.memberAdded') : i18n.t('admin.toast.userExists'),
      );
      setManualDraft(null);
    },
    onError: errToast('common.error'),
  });

  // M1.10 (2026-05-08): people directory search by name + tg + role.
  const [searchQuery, setSearchQuery] = useState('');
  const tokens = useMemo(() => normalizeQuery(searchQuery), [searchQuery]);

  // The member whose sheet is open, read from the list so that it shows
  // a role the moment it is granted or revoked.
  const openMember = membersQuery.data?.find((m) => m.memberId === openId) ?? null;
  const here = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const visible = (membersQuery.data ?? []).filter(
    (m) =>
      (storeCtx.kind === 'specific'
        ? m.stores.some((st) => st.id === storeCtx.storeId)
        : storeCtx.kind === 'org-level'
          ? m.stores.length === 0
          : true) &&
      (!tokens ||
        matchesAnyString(
          [
            m.displayName,
            m.tgUsername,
            ...m.roles.map((r) => r.slug),
            ...m.roles.map((r) => r.name),
          ],
          tokens,
        )),
  );
  const roleNames = (m: (typeof visible)[number]) =>
    m.roles
      // Looking at one store, a role held in another store is not said.
      .filter((r) => !here || r.scopeType !== 'store' || r.scopeId === here)
      .map((r) => r.name);
  const QUIET =
    'flex h-control w-full items-center justify-center rounded-pill bg-surface-sunken px-lg text-label text-ink outline-none active:opacity-70 disabled:opacity-50';

  return (
    <div className="flex flex-col gap-xl px-page pt-sm">
      <button
        type="button"
        data-testid="member-invite"
        onClick={() => setInviteOpen(true)}
        className="flex items-center gap-lg rounded-lg border border-dashed border-line p-xl text-start outline-none active:opacity-60"
      >
        <span
          aria-hidden
          className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
        >
          <PlusIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-label text-ink">{i18n.t('people.invite')}</span>
          <span className="block text-small text-secondary">{i18n.t('people.inviteHow')}</span>
        </span>
        <span className="shrink-0 text-forest">
          <ChevronIcon />
        </span>
      </button>

      <label className="flex h-control items-center gap-md rounded-pill bg-field px-lg text-secondary ring-1 ring-inset ring-secondary focus-within:ring-2 focus-within:ring-ink">
        <SearchIcon />
        <input
          type="search"
          aria-label={i18n.t('admin.search.peoplePlaceholder')}
          placeholder={i18n.t('admin.search.peoplePlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-secondary"
        />
      </label>

      {membersQuery.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : membersQuery.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : visible.length === 0 ? (
        <div className="flex items-center gap-lg">
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
          >
            <ClockIcon />
          </span>
          <span className="text-label text-secondary">
            {tokens
              ? i18n.t('admin.search.noMatches.title')
              : storeCtx.kind === 'org-level'
                ? i18n.t('people.orgLevelEmptyTitle')
                : i18n.t('admin.empty.noStoresInThisStore.title')}
          </span>
        </div>
      ) : (
        <ul className="flex flex-col">
          {visible.map((m) => {
            const isSelf = m.userId === session?.user.id;
            const roles = roleNames(m);
            return (
              <li key={m.memberId}>
                <button
                  type="button"
                  data-testid="member-row"
                  onClick={() => setOpenId(m.memberId)}
                  className="flex min-h-row w-full items-center gap-lg py-sm text-start outline-none active:opacity-60"
                >
                  <span
                    aria-hidden
                    className="flex size-avatar shrink-0 items-center justify-center overflow-hidden rounded-pill bg-surface text-label text-ink"
                  >
                    {m.avatarUrl ? (
                      <img src={m.avatarUrl} alt="" className="size-full object-cover" />
                    ) : (
                      (Array.from(m.displayName.trim())[0] ?? '')
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-label text-ink">
                      {m.displayName}
                      {isSelf ? ` · ${i18n.t('admin.label.you')}` : ''}
                    </span>
                    <span className="block text-small text-secondary">
                      {roles.length > 0 ? roles.join(' · ') : i18n.t('people.noRole')}
                    </span>
                  </span>
                  {/* Active is the silent default; only the exception says so. */}
                  {m.status !== 'active' ? (
                    <StatusChip tone="pending">{i18n.t('people.suspended')}</StatusChip>
                  ) : null}
                  <span className="shrink-0 text-forest">
                    <ChevronIcon />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <GrantRoleSheet target={grantFor} onClose={() => setGrantFor(null)} />
      <ManageMemberSheet target={manageFor} onClose={() => setManageFor(null)} />
      <MemberPermissionsSheet target={permsFor} onClose={() => setPermsFor(null)} />

      {/* One person: what they hold, and everything that can be done
          about them. It used to be three buttons on every card and a
          fourth that opened a menu. */}
      <KitSheet
        open={!!openMember}
        onOpenChange={(next) => !next && setOpenId(null)}
        title={openMember?.displayName ?? ''}
        actions={
          openMember ? (
            <>
              <KitButton
                variant="primary"
                data-testid="member-grant"
                onClick={() => {
                  setOpenId(null);
                  setGrantFor({
                    userId: openMember.userId,
                    displayName: openMember.displayName,
                    defaultStoreId: here,
                  });
                }}
              >
                {i18n.t('admin.action.grantRole')}
              </KitButton>
              <button
                type="button"
                data-testid="member-manage"
                className={QUIET}
                onClick={() => {
                  setOpenId(null);
                  setManageFor({
                    memberId: openMember.memberId,
                    userId: openMember.userId,
                    displayName: openMember.displayName,
                  });
                }}
              >
                {i18n.t('admin.action.manage')}
              </button>
            </>
          ) : undefined
        }
      >
        {openMember ? (
          <div className="flex flex-col gap-xl">
            <p className="text-body text-secondary">
              {[
                openMember.tgUsername
                  ? `@${openMember.tgUsername}`
                  : i18n.t('admin.label.noTelegram'),
                openMember.lastSeenAt
                  ? i18n.t('admin.label.seen', { date: dateFmt.date(openMember.lastSeenAt) })
                  : i18n.t('admin.label.neverSeen'),
                ...openMember.stores.map((st) => st.name),
              ].join(' · ')}
            </p>

            <section className="flex flex-col gap-sm">
              <h3 className="text-body text-secondary">{i18n.t('people.roles')}</h3>
              {openMember.roles.length === 0 ? (
                <p className="text-label text-secondary">{i18n.t('people.noRole')}</p>
              ) : (
                openMember.roles.map((r) => {
                  const where =
                    r.scopeType === 'store' && r.scopeId
                      ? (openMember.stores.find((st) => st.id === r.scopeId)?.name ?? null)
                      : null;
                  return (
                    <div key={r.bindingId} className="flex min-h-row items-center gap-lg">
                      <span className="min-w-0 flex-1">
                        <span className="block text-label text-ink">{r.name}</span>
                        <span className="block text-small text-secondary">
                          {where ?? i18n.t('people.everyStore')}
                        </span>
                      </span>
                      <button
                        type="button"
                        data-testid="member-revoke"
                        disabled={revoke.isPending}
                        onClick={() =>
                          nativeConfirm(
                            i18n.t('people.confirmRevoke', {
                              role: where ? `${r.name} · ${where}` : r.name,
                              name: openMember.displayName,
                            }),
                            () => revoke.mutate({ bindingId: r.bindingId }),
                          )
                        }
                        className="flex h-pillbtn shrink-0 items-center rounded-pill bg-surface-sunken px-lg text-label text-ink outline-none active:opacity-70 disabled:opacity-50"
                      >
                        {i18n.t('people.revoke')}
                      </button>
                    </div>
                  );
                })
              )}
            </section>

            {/* The rarer things, and the ones that cannot be done to
                oneself. Each asks before it does anything. */}
            <section className="flex flex-col gap-sm">
              {isGlobalAdminPeople ? (
                <button
                  type="button"
                  className={QUIET}
                  onClick={() => {
                    setOpenId(null);
                    setPermsFor({
                      memberId: openMember.memberId,
                      displayName: openMember.displayName,
                      stores: openMember.stores.map((st) => ({ id: st.id, name: st.name })),
                    });
                  }}
                >
                  {i18n.t('admin.action.permissions')}
                </button>
              ) : null}
              {openMember.userId !== session?.user.id ? (
                <>
                  {openMember.status === 'active' ? (
                    <button
                      type="button"
                      data-testid="member-suspend"
                      className={QUIET}
                      onClick={() =>
                        nativeConfirm(
                          i18n.t('admin.confirm.suspend', { name: openMember.displayName }),
                          () =>
                            setStatus.mutate({
                              memberId: openMember.memberId,
                              status: 'suspended',
                            }),
                        )
                      }
                    >
                      {i18n.t('admin.action.suspend')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="member-reactivate"
                      className={QUIET}
                      onClick={() =>
                        setStatus.mutate({ memberId: openMember.memberId, status: 'active' })
                      }
                    >
                      {i18n.t('admin.action.reactivate')}
                    </button>
                  )}
                  {here && openMember.stores.some((st) => st.id === here) ? (
                    <button
                      type="button"
                      data-testid="member-detach"
                      className={QUIET}
                      onClick={() => {
                        const target = openMember;
                        nativeConfirm(
                          i18n.t('admin.confirm.removeFromStore', {
                            name: target.displayName,
                            store:
                              target.stores.find((st) => st.id === here)?.name ??
                              i18n.t('admin.label.thisStore'),
                          }),
                          () => {
                            setOpenId(null);
                            detachFromStore.mutate({ memberId: target.memberId, storeId: here });
                          },
                        );
                      }}
                    >
                      {i18n.t('admin.action.removeFromStore')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    data-testid="member-remove"
                    className={QUIET}
                    onClick={() => {
                      const target = openMember;
                      nativeConfirm(
                        i18n.t('admin.confirm.removeFromOrg', { name: target.displayName }),
                        () => {
                          setOpenId(null);
                          remove.mutate({ memberId: target.memberId });
                        },
                      );
                    }}
                  >
                    <span className="text-danger">{i18n.t('admin.action.removeFromOrg')}</span>
                  </button>
                </>
              ) : null}
            </section>
          </div>
        ) : null}
      </KitSheet>
      <InviteHubSheet
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onPickManual={() => {
          setInviteOpen(false);
          setManualDraft({ tgUserId: '', displayName: '', roleSlug: '', storeIds: [] });
        }}
      />
      <ManualInviteSheet
        draft={manualDraft}
        setDraft={setManualDraft}
        onSubmit={() => {
          if (!manualDraft) return;
          invite.mutate({
            tgUserId: manualDraft.tgUserId,
            displayName: manualDraft.displayName || undefined,
            roleSlug: manualDraft.roleSlug || undefined,
            storeIds: manualDraft.storeIds,
          });
        }}
        pending={invite.isPending}
      />
    </div>
  );
}

/**
 * Roles & Permissions screen — replaces the old read-only RolesList.
 *
 * Shows every role in the org with its rank + permission count, ordered
 * highest rank first (super_admin → admin → manager → ...). Each row
 * carries a small "Cannot grant" badge when the role's rank is ≥ the
 * viewer's own max rank — the user explicitly asked: "能接触权限管理
 * 的人不能分配跟自己同级或比自己高权限给别人". The rank shown here is
 * the same rank the server uses to gate `admin.grantRole`.
 *
 * Tap a role row → drill-down sheet listing the explicit permission
 * keys it grants. This is the closest thing to a permission matrix
 * we ship today; a full editable matrix belongs in round 4 (custom
 * roles).
 */
export function PermissionsSection({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const myMaxRank = session?.myMaxRank ?? 0;
  const rolesQuery = trpc.admin.roleList.useQuery();
  const [drilldownSlug, setDrilldownSlug] = useState<string | null>(null);
  // Custom-role create-mode flag (added 2026-05-05). When true the
  // sheet opens with empty fields and a "Create" footer instead of
  // the existing role's data.
  const [createOpen, setCreateOpen] = useState(false);
  // M1.9 (2026-05-07): only global admins can create org-wide roles.
  // Per-store managers (post-B1 with users.manage) shouldn't see the
  // "+ New role" button — server-side rank gate would block them
  // anyway, but a button that always errors is bad UX.
  const sessionStores = session?.stores ?? [];
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const isGlobalAdmin = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0;
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);

  return (
    <div className="px-4 py-3">
      <Banner tone="info" title={i18n.t('people.permsHowTitle')}>
        {i18n.t('people.permsHowBody', { rank: myMaxRank })}
      </Banner>
      <div className="mt-3 flex items-center justify-between">
        <SectionLabel padded={false}>{i18n.t('people.rolesHeading')}</SectionLabel>
        {isGlobalAdmin ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            + {i18n.t('people.newRoleButton')}
          </Button>
        ) : null}
      </div>
      <div className="mt-2">
        <DataState
          query={rolesQuery}
          emptyWhen={(d) => d.length === 0}
          empty={
            <EmptyState
              title={i18n.t('people.rolesEmptyTitle')}
              description={i18n.t('people.rolesEmptyBody')}
            />
          }
        >
          {(rows) => (
            <ul className="flex flex-col gap-2" role="list">
              {rows.map((r) => {
                const grantable = r.rank < myMaxRank;
                const subtitleParts: string[] = [
                  i18n.t('people.rankLine', { rank: r.rank }),
                  i18n.t('people.permissionCount', { n: r.permissionCount }),
                ];
                if (r.description) subtitleParts.push(r.description);
                const subtitle = subtitleParts.join(' · ');
                return (
                  <li key={r.id}>
                    <ListRow
                      label={
                        <span className="flex items-center gap-2">
                          {r.name}
                          {r.isBuiltIn ? (
                            <Badge tone="muted">{i18n.t('admin.label.builtIn')}</Badge>
                          ) : null}
                        </span>
                      }
                      hint={subtitle}
                      badge={
                        // UIUX-B1: 'grantable' is the common case → silent;
                        // only the blocking state earns a badge.
                        grantable ? null : (
                          <Badge tone="warn">{i18n.t('people.rankOutranksYou')}</Badge>
                        )
                      }
                      onClick={() => setDrilldownSlug(r.slug)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </DataState>
      </div>

      <RolePermissionsSheet
        open={!!drilldownSlug}
        roleSlug={drilldownSlug}
        onClose={() => setDrilldownSlug(null)}
        canEdit={isSuperAdmin}
        myMaxRank={myMaxRank}
      />
      <RoleCreateSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        myMaxRank={myMaxRank}
      />
    </div>
  );
}

/**
 * Sheet for creating a new custom role (added 2026-05-05).
 *
 * Flow: admin types slug + name + rank, picks permission keys from a
 * matrix (grouped by namespace). Server validates slug is unique and
 * rank is below the actor. Closes on success.
 *
 * The permission matrix is a flat list of checkboxes, grouped by
 * namespace (`order.*`, `run.*`, ...) — same structure as the
 * RolePermissionsSheet's read view, just interactive.
 */
function RoleCreateSheet({
  open,
  onClose,
  myMaxRank,
}: {
  open: boolean;
  onClose: () => void;
  myMaxRank: number;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const permsQuery = trpc.admin.permissionList.useQuery(undefined, { enabled: open });
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Default rank = max - 10 (one tier below the actor). The lower
  // bound is 1; admins can adjust freely.
  const defaultRank = Math.max(1, myMaxRank - 10);
  const [rank, setRank] = useState(defaultRank);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  // Reset when sheet re-opens for a fresh create.
  useEffect(() => {
    if (open) {
      setSlug('');
      setName('');
      setDescription('');
      setRank(Math.max(1, myMaxRank - 10));
      setPicked(new Set());
    }
  }, [open, myMaxRank]);

  const grouped = useMemo(() => {
    const m = new Map<string, Array<{ key: string; description: string | null }>>();
    for (const p of permsQuery.data ?? []) {
      const ns = p.key.split('.')[0] ?? 'misc';
      const arr = m.get(ns) ?? [];
      arr.push({ key: p.key, description: p.description });
      m.set(ns, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [permsQuery.data]);

  const create = trpc.admin.roleCreate.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      toast.success(i18n.t('admin.toast.roleCreated'));
      onClose();
    },
    onError: errToast('common.error'),
  });

  const togglePerm = (key: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const canSave =
    slug.trim().length > 0 &&
    /^[a-z0-9-]+$/.test(slug) &&
    name.trim().length > 0 &&
    rank > 0 &&
    rank < myMaxRank;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={i18n.t('people.newRoleTitle')}
      description={i18n.t('people.newRoleHint', { max: myMaxRank - 1 })}
      footer={
        <Button
          block
          loading={create.isPending}
          disabled={!canSave}
          onClick={() => {
            create.mutate({
              slug: slug.trim().toLowerCase(),
              name: name.trim(),
              description: description.trim() || null,
              rank,
              permissionKeys: [...picked],
            });
          }}
        >
          {i18n.t('common.create')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 py-3">
        <Field label={`${i18n.t('admin.field.slug')} *`}>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            maxLength={64}
            placeholder="e.g. shift-lead"
            autoFocus
          />
        </Field>
        <Field label={`${i18n.t('admin.field.name')} *`}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder={i18n.t('people.rolePlaceholderName')}
          />
        </Field>
        <Field label={i18n.t('admin.field.description')}>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder={i18n.t('people.rolePlaceholderDesc')}
          />
        </Field>
        <Field label={`${i18n.t('people.rankField', { max: myMaxRank - 1 })} *`}>
          <Input
            type="number"
            value={String(rank)}
            onChange={(e) =>
              setRank(Math.max(1, Math.min(myMaxRank - 1, Number(e.target.value) || 0)))
            }
          />
        </Field>
        <div>
          {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
          <SectionLabel className="mb-2 px-0">Permissions ({picked.size})</SectionLabel>
          {permsQuery.isLoading ? (
            <Spinner size={16} />
          ) : (
            <ul className="flex flex-col gap-3">
              {grouped.map(([ns, keys]) => (
                <li key={ns}>
                  <SectionLabel padded={false}>{ns}</SectionLabel>
                  <ul className="mt-1 flex flex-col gap-1">
                    {keys.map((p) => (
                      <li key={p.key}>
                        <label className="flex cursor-pointer items-start gap-2 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-2 text-old-label active:opacity-80">
                          <input
                            type="checkbox"
                            checked={picked.has(p.key)}
                            onChange={() => togglePerm(p.key)}
                            className="mt-0.5 h-4 w-4"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-old-label">{p.key}</div>
                            {p.description ? (
                              <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                                {p.description}
                              </div>
                            ) : null}
                          </div>
                        </label>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** Sheet showing the explicit permission keys for one role. Read-only
 *  for now; the canEdit prop reserves space for the editable matrix. */
function RolePermissionsSheet({
  open,
  roleSlug,
  onClose,
  canEdit,
  myMaxRank,
}: {
  open: boolean;
  roleSlug: string | null;
  onClose: () => void;
  canEdit: boolean;
  myMaxRank: number;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const detail = trpc.admin.roleDetail.useQuery(
    { roleSlug: roleSlug ?? '' },
    { enabled: !!roleSlug },
  );
  const permsQuery = trpc.admin.permissionList.useQuery(undefined, {
    enabled: open && canEdit,
  });

  // Edit-mode: false (read view) by default. Toggle on Edit click.
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rank, setRank] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  // Hydrate local state when role data lands or sheet re-opens.
  useEffect(() => {
    if (!detail.data) return;
    setName(detail.data.name);
    setDescription(detail.data.description ?? '');
    setRank(detail.data.rank);
    setPicked(new Set(detail.data.permissions));
    setEditing(false);
  }, [detail.data, open]);

  // Below-rank gate — only roles strictly below actor's rank are editable.
  const isEditable = canEdit && (detail.data?.rank ?? 100) < myMaxRank;
  const isBuiltIn = detail.data?.isBuiltIn ?? false;

  const update = trpc.admin.roleUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      void utils.admin.roleDetail.invalidate({ roleSlug: roleSlug ?? '' });
      toast.success(i18n.t('admin.toast.roleUpdated'));
      setEditing(false);
    },
    onError: errToast('common.error'),
  });
  const remove = trpc.admin.roleDelete.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      toast.success(i18n.t('admin.toast.roleDeleted'));
      onClose();
    },
    onError: errToast('common.error'),
  });

  const togglePerm = (key: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Edit-mode source: full permission catalog. Read-mode source: only
  // the permissions the role currently has. Group both by namespace.
  const grouped = useMemo(() => {
    const source: Array<{ key: string; description: string | null }> = editing
      ? (permsQuery.data ?? []).map((p) => ({ key: p.key, description: p.description }))
      : (detail.data?.permissions ?? []).map((k) => ({ key: k, description: null }));
    const m = new Map<string, Array<{ key: string; description: string | null }>>();
    for (const p of source) {
      const ns = p.key.split('.')[0] ?? 'misc';
      const arr = m.get(ns) ?? [];
      arr.push(p);
      m.set(ns, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [editing, detail.data, permsQuery.data]);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={detail.data?.name ?? i18n.t('people.roleFallback')}
      description={
        detail.data
          ? i18n.t('people.roleMetaLine', {
              rank: detail.data.rank,
              perms: i18n.t('people.permissionCount', {
                n: detail.data.permissions.length,
              }),
            }) + (isBuiltIn ? ` · ${i18n.t('admin.label.builtIn')}` : '')
          : undefined
      }
      footer={
        editing && detail.data ? (
          <div className="flex flex-col gap-2">
            <Button
              block
              loading={update.isPending}
              onClick={() => {
                update.mutate({
                  roleId: detail.data!.id,
                  name: name.trim(),
                  description: description.trim() || null,
                  // Built-in roles can't change rank (anchors the ladder).
                  ...(isBuiltIn ? {} : { rank }),
                  permissionKeys: [...picked],
                });
              }}
            >
              {i18n.t('common.save')}
            </Button>
            <Button block variant="pearl" onClick={() => setEditing(false)}>
              {i18n.t('common.cancel')}
            </Button>
          </div>
        ) : isEditable && detail.data ? (
          <div className="flex flex-col gap-2">
            <Button block onClick={() => setEditing(true)}>
              {i18n.t('common.edit')}
            </Button>
            {!isBuiltIn ? (
              <Button
                block
                variant="danger"
                loading={remove.isPending}
                onClick={() => {
                  nativeConfirm(
                    i18n.t('people.confirmDeleteRole', { name: detail.data!.name }),
                    () => remove.mutate({ roleId: detail.data!.id }),
                  );
                }}
              >
                {i18n.t('people.deleteRole')}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {detail.isLoading ? (
        <div className="py-8 text-center text-old-body text-[var(--c-fg-muted)]">Loading…</div>
      ) : !detail.data ? (
        <div className="py-8 text-center text-old-body text-[var(--c-fg-muted)]">
          {i18n.t('people.noRole')}
        </div>
      ) : (
        <div className="flex flex-col gap-3 py-3">
          {editing ? (
            <>
              <Field label={`${i18n.t('admin.field.name')} *`}>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
              </Field>
              <Field label={i18n.t('admin.field.description')}>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                />
              </Field>
              {isBuiltIn ? (
                <Banner tone="info" title={i18n.t('people.builtInLocked', { rank })}>
                  {i18n.t('people.builtInRankBody')}
                </Banner>
              ) : (
                <Field label={`${i18n.t('people.rankField', { max: myMaxRank - 1 })} *`}>
                  <Input
                    type="number"
                    value={String(rank)}
                    onChange={(e) =>
                      setRank(Math.max(1, Math.min(myMaxRank - 1, Number(e.target.value) || 0)))
                    }
                  />
                </Field>
              )}
              {/* M2.1: SectionLabel (was ad-hoc eyebrow div). */}
              <SectionLabel className="px-0">Permissions ({picked.size})</SectionLabel>
            </>
          ) : detail.data.description ? (
            <p className="text-old-body-sm text-[var(--c-fg-muted)]">{detail.data.description}</p>
          ) : null}
          {grouped.length === 0 ? (
            <p className="text-old-body text-[var(--c-fg-muted)]">
              {i18n.t('people.noPermsAssigned')}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {grouped.map(([ns, keys]) => (
                <li key={ns}>
                  <SectionLabel padded={false}>{ns}</SectionLabel>
                  <ul className="mt-1 flex flex-col gap-1">
                    {keys.map((p) => {
                      if (editing) {
                        return (
                          <li key={p.key}>
                            <label className="flex cursor-pointer items-start gap-2 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-2 text-old-label active:opacity-80">
                              <input
                                type="checkbox"
                                checked={picked.has(p.key)}
                                onChange={() => togglePerm(p.key)}
                                className="mt-0.5 h-4 w-4"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="font-mono text-old-label">{p.key}</div>
                                {p.description ? (
                                  <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                                    {p.description}
                                  </div>
                                ) : null}
                              </div>
                            </label>
                          </li>
                        );
                      }
                      return (
                        <li
                          key={p.key}
                          className="rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-1.5 font-mono text-old-label"
                        >
                          {p.key}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {/* B1 (2026-05-06): assignees grouped by store. Read-only —
              edits go through the existing role chip on the People
              cards. Hidden when editing the role itself to keep the
              edit-form focused. */}
          {!editing && detail.data.assignees.length > 0 ? (
            <RoleAssigneesByStore assignees={detail.data.assignees} />
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

/**
 * RoleAssigneesByStore (B1, 2026-05-06).
 *
 * Buckets role bindings into "Org-level" (scope=global) plus one
 * section per store. Each row shows the assignee's display name +
 * @username; tapping doesn't navigate (this view is for "who is
 * where", not for editing — that's on the member card).
 */
function RoleAssigneesByStore({
  assignees,
}: {
  assignees: Array<{
    bindingId: string;
    memberId: string;
    displayName: string;
    avatarUrl: string | null;
    tgUsername: string | null;
    scopeType: 'global' | 'store';
    scopeId: string | null;
    storeName: string | null;
  }>;
}) {
  const i18n = useI18n();
  const grouped = useMemo(() => {
    // 'org-level' bucket plus per-store buckets keyed by storeId.
    type Bucket = { label: string; members: typeof assignees };
    const buckets = new Map<string, Bucket>();
    const orgLevelKey = '__org__';
    for (const a of assignees) {
      let key: string;
      let label: string;
      if (a.scopeType === 'global' || !a.scopeId) {
        key = orgLevelKey;
        label = i18n.t('people.orgLevelLabel');
      } else {
        key = a.scopeId;
        label = a.storeName ?? i18n.t('people.storeGone');
      }
      const cur = buckets.get(key) ?? { label, members: [] };
      cur.members.push(a);
      buckets.set(key, cur);
    }
    // Sort: org-level first, then alphabetical store name.
    const out = [...buckets.entries()];
    out.sort(([ka, va], [kb, vb]) => {
      if (ka === orgLevelKey) return -1;
      if (kb === orgLevelKey) return 1;
      return va.label.localeCompare(vb.label);
    });
    return out;
  }, [assignees]);

  return (
    <div className="mt-2 border-t border-[var(--c-divider)] pt-3">
      <SectionLabel padded={false}>Assignees · {assignees.length}</SectionLabel>
      <div className="mt-1 flex flex-col gap-3">
        {grouped.map(([key, bucket]) => (
          <section key={key}>
            <h4 className="mb-1 text-old-label font-semibold text-[var(--c-fg-muted)]">
              {bucket.label} ({bucket.members.length})
            </h4>
            <ul className="flex flex-col gap-1">
              {bucket.members.map((a) => (
                <li
                  key={a.bindingId}
                  className="flex items-center gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-1.5"
                >
                  <Avatar src={a.avatarUrl} name={a.displayName} size={24} />
                  <span className="text-old-body text-[var(--c-fg)]">{a.displayName}</span>
                  {a.tgUsername ? (
                    <span className="text-old-label text-[var(--c-fg-muted)]">@{a.tgUsername}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Telegram-native invite hub. The first option is "Share via Telegram"
 * which opens Telegram's contact picker pre-filled with the bot link;
 * the recipient opens the bot, sends /id, then the admin uses the
 * second option (manual TG ID add) to actually grant membership. The
 * bot deep-link flow that lets the recipient self-join their org will
 * land in M2 along with invite tokens.
 */
function InviteHubSheet({
  open,
  onClose,
  onPickManual,
}: {
  open: boolean;
  onClose: () => void;
  onPickManual: () => void;
}) {
  const session = useAuthStore((s) => s.session);
  const toast = useToast();
  const i18n = useI18n();
  const cfgQuery = trpc.system.appConfig.useQuery(undefined, {
    enabled: open,
    staleTime: STALE.long,
  });

  const botUsername = cfgQuery.data?.botUsername?.replace(/^@/, '') ?? null;
  const botLink = makeBotLink(botUsername);
  const message = i18n.t('people.inviteMessage', { org: session?.member.orgName ?? '' });
  const shareUrl = makeShareLink({ url: botLink, text: message });

  const handleShare = () => {
    const tg = getTg();
    if (tg) {
      tg.openTelegramLink(shareUrl);
    } else if (typeof window !== 'undefined') {
      window.open(shareUrl, '_blank');
    }
    onClose();
  };

  const handleCopy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(`${botLink}\n\n${message}`);
        toast.success(i18n.t('admin.toast.linkCopied'));
      } else {
        toast.error(i18n.t('admin.toast.clipboardUnavailable'));
      }
    } catch {
      toast.error(i18n.t('admin.toast.couldNotCopy'));
    }
  };

  return (
    <KitSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={i18n.t('people.inviteTitle')}
    >
      <div className="flex flex-col">
        {[
          {
            key: 'share',
            title: i18n.t('people.inviteViaTelegram'),
            hint: botUsername
              ? i18n.t('people.inviteViaTelegramHint')
              : i18n.t('people.inviteNoBot'),
            onClick: handleShare,
            disabled: !botUsername,
          },
          {
            key: 'copy',
            title: i18n.t('people.inviteCopyLink'),
            hint: i18n.t('people.inviteCopyLinkHint'),
            onClick: () => void handleCopy(),
            disabled: !botUsername,
          },
          {
            key: 'manual',
            title: i18n.t('people.inviteByTgId'),
            hint: i18n.t('people.inviteByTgIdHint'),
            onClick: onPickManual,
            disabled: false,
          },
        ].map((way) => (
          <button
            key={way.key}
            type="button"
            data-testid={`invite-${way.key}`}
            onClick={way.onClick}
            disabled={way.disabled}
            className="flex min-h-row items-center gap-lg py-md text-start outline-none active:opacity-60 disabled:opacity-50"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-label text-ink">{way.title}</span>
              <span className="block text-small text-secondary">{way.hint}</span>
            </span>
            <span className="shrink-0 text-forest">
              <ChevronIcon />
            </span>
          </button>
        ))}
      </div>
    </KitSheet>
  );
}

function ManualInviteSheet({
  draft,
  setDraft,
  onSubmit,
  pending,
}: {
  draft: InviteDraft | null;
  setDraft: (d: InviteDraft | null) => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  const i18n = useI18n();
  const rolesQuery = trpc.admin.roleList.useQuery(undefined, { enabled: !!draft });
  const storesQuery = trpc.admin.storeList.useQuery(undefined, { enabled: !!draft });
  // C2 (2026-05-06): a store-scoped admin can only invite into the
  // stores they administer. We filter the role list AND the store
  // multi-select against `session.adminStoreIds`. Org-tier roles
  // (admin / super_admin) get hidden when the actor isn't a global
  // admin — a store-scoped manager has no business creating org-tier
  // members; the server gate would reject anyway.
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const sessionStores = session?.stores ?? [];
  const isGlobalAdmin = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0;
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);

  const sortedRoles = useMemo(
    () =>
      [...(rolesQuery.data ?? [])]
        // Hide org-tier roles for non-global admins (mirrors server's
        // cannotInviteOrgAdminAsStoreAdmin gate). The role still exists
        // server-side; this is purely a UX decision.
        .filter((r) => isGlobalAdmin || r.rank < ADMIN_RANK)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rolesQuery.data, isGlobalAdmin],
  );
  const eligibleStores = useMemo(
    () => (storesQuery.data ?? []).filter((st) => adminStoreIds.has(st.id)),
    [storesQuery.data, adminStoreIds],
  );

  const tgIdValid = draft ? /^\d{4,15}$/.test(draft.tgUserId) : false;
  // Adminish roles bypass the store check at the server side, so we
  // shouldn't force the admin to pick a store for them.
  const isAdminRole = draft?.roleSlug === 'admin' || draft?.roleSlug === 'super_admin';
  const requiresStore = !isAdminRole;
  const hasStore = (draft?.storeIds.length ?? 0) > 0;
  const canSubmit = tgIdValid && (!requiresStore || hasStore);
  return (
    <KitSheet
      open={!!draft}
      onOpenChange={(open) => !open && !pending && setDraft(null)}
      title={i18n.t('admin.invite.byTgId.title')}
      actions={
        <KitButton
          variant="primary"
          data-testid="invite-submit"
          busy={pending}
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          {i18n.t('admin.invite.byTgId.submit')}
        </KitButton>
      }
    >
      {draft ? (
        <div className="flex flex-col gap-xl">
          <div className="flex flex-col gap-sm">
            <KitField
              label={i18n.t('admin.field.tgUserId')}
              value={draft.tgUserId}
              inputMode="numeric"
              maxLength={15}
              placeholder={i18n.t('admin.field.tgUserIdPlaceholder')}
              onChange={(e) =>
                setDraft({ ...draft, tgUserId: e.target.value.replace(/\D/g, '').slice(0, 15) })
              }
            />
            <p className="text-small text-secondary">{i18n.t('admin.invite.tgIdHint')}</p>
          </div>
          <KitField
            label={i18n.t('admin.field.displayName')}
            value={draft.displayName}
            maxLength={200}
            placeholder={i18n.t('admin.field.displayNamePlaceholder')}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          />

          <div className="flex flex-col gap-sm">
            <span className="text-label text-ink">{i18n.t('admin.field.role')}</span>
            {rolesQuery.isLoading ? (
              <p className="text-small text-secondary">{i18n.t('admin.label.loadingRoles')}</p>
            ) : (
              <div className="flex flex-wrap gap-sm">
                {[{ slug: '', name: i18n.t('admin.invite.noRoleYet') }, ...sortedRoles].map((r) => (
                  <button
                    key={r.slug || 'none'}
                    type="button"
                    aria-pressed={draft.roleSlug === r.slug}
                    data-testid="invite-role"
                    onClick={() => setDraft({ ...draft, roleSlug: r.slug })}
                    className={capsule(draft.roleSlug === r.slug)}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {requiresStore ? (
            <div className="flex flex-col gap-sm">
              <span className="text-label text-ink">
                {hasStore
                  ? i18n.t('admin.field.storesSelected', { n: draft.storeIds.length })
                  : i18n.t('admin.field.storesPickAtLeastOne')}
              </span>
              {storesQuery.isLoading ? (
                <p className="text-small text-secondary">{i18n.t('admin.label.loadingStores')}</p>
              ) : eligibleStores.length === 0 ? (
                <div role="status" className="rounded-lg bg-warning-pale p-xl">
                  <p className="text-label text-warning-ink">
                    {i18n.t('admin.banner.noStoresToInviteInto.title')}
                  </p>
                  <p className="text-small text-warning-ink">
                    {i18n.t('admin.banner.noStoresToInviteInto.body')}
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-sm">
                  {eligibleStores.map((st) => {
                    const checked = draft.storeIds.includes(st.id);
                    return (
                      <button
                        key={st.id}
                        type="button"
                        aria-pressed={checked}
                        data-testid="invite-store"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            storeIds: checked
                              ? draft.storeIds.filter((id) => id !== st.id)
                              : [...draft.storeIds, st.id],
                          })
                        }
                        className={capsule(checked)}
                      >
                        {st.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-small text-secondary">
                {i18n.t('admin.invite.staffNeedStoreHint')}
                {!isGlobalAdmin ? ' ' + i18n.t('admin.invite.onlyYourStoresHint') : ''}
              </p>
            </div>
          ) : (
            <p className="text-small text-secondary">{i18n.t('admin.invite.adminBypassHint')}</p>
          )}
        </div>
      ) : null}
    </KitSheet>
  );
}

/**
 * Per-member admin panel: rename + per-store assignment.
 * - Rename bypasses the user's `displayNameLocked` flag (admin override).
 * - Store assignments are toggle-checkboxes against `admin.storeList`,
 *   with a live mutation per click. The query auto-invalidates so the
 *   UI updates without a full refresh.
 */
function ManageMemberSheet({
  target,
  onClose,
}: {
  target: { memberId: string; userId: string; displayName: string } | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const open = !!target;
  const storesQuery = trpc.admin.storeList.useQuery(undefined, { enabled: open });
  const assignmentsQuery = trpc.admin.memberStoreAssignments.useQuery(
    target ? { memberId: target.memberId } : { memberId: '00000000-0000-0000-0000-000000000000' },
    { enabled: open && !!target },
  );
  // C2 (2026-05-06): a store-scoped admin can only assign/unassign in
  // the stores they administer. Stores outside `adminStoreIds` are
  // shown as read-only rows so the operator can see WHO the member
  // already belongs to (even cross-store), but can only mutate the
  // stores they actually run.
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  // M1.9: gate cross-store moves behind global-admin only. For per-
  // store managers (who post-B1 have users.manage), the unassign +
  // reassign workflow on the checkbox grid is enough; the dedicated
  // Transfer wizard is an org-wide-write surface they shouldn't reach.
  const sessionStores = session?.stores ?? [];
  const isGlobalAdmin = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0;
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);
  const [name, setName] = useState(target?.displayName ?? '');
  // Refresh local name field when target changes.
  useEffect(() => {
    if (target) setName(target.displayName);
  }, [target]);

  const renameMut = trpc.admin.memberSetDisplayName.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.success(i18n.t('admin.toast.memberUpdated'));
    },
    onError: errToast('common.error'),
  });
  const assignMut = trpc.admin.memberAssignStore.useMutation({
    onSuccess: () => {
      void utils.admin.memberStoreAssignments.invalidate();
    },
    onError: errToast('common.error'),
  });
  const unassignMut = trpc.admin.memberUnassignStore.useMutation({
    onSuccess: () => {
      void utils.admin.memberStoreAssignments.invalidate();
    },
    onError: errToast('common.error'),
  });

  const assignedIds = useMemo(
    () => new Set((assignmentsQuery.data ?? []).map((r) => r.storeId)),
    [assignmentsQuery.data],
  );

  // D2 (2026-05-06): transfer wizard state. fromStoreId is set when
  // the operator taps "Transfer..." on a particular row. The sheet
  // mounts as a modal-on-modal which is fine on Telegram WebApp
  // because Sheets stack.
  const [transferFrom, setTransferFrom] = useState<{
    storeId: string;
    storeName: string;
  } | null>(null);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={target?.displayName ?? i18n.t('people.memberFallback')}
      description={i18n.t('people.editMemberHint')}
    >
      {target ? (
        <div className="flex flex-col gap-4 py-3">
          <Field label={i18n.t('admin.field.displayNameOverride')}>
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                placeholder="display name"
              />
              <Button
                size="sm"
                loading={renameMut.isPending}
                disabled={!name.trim() || name.trim() === target.displayName}
                onClick={() =>
                  renameMut.mutate({ memberId: target.memberId, displayName: name.trim() })
                }
              >
                {i18n.t('common.save')}
              </Button>
            </div>
            <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('people.nameOverrideHint')}
            </p>
          </Field>

          <Field label={i18n.t('admin.field.assignedStores')}>
            {storesQuery.isLoading || assignmentsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-old-body-sm text-[var(--c-fg-muted)]">
                <Spinner size={14} /> Loading…
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
                {(storesQuery.data ?? []).map((st) => {
                  const checked = assignedIds.has(st.id);
                  const pending = assignMut.isPending || unassignMut.isPending;
                  // C2: stores you don't administer are visible (so
                  // you see the full picture) but the checkbox is
                  // disabled. The server would reject anyway.
                  const editable = adminStoreIds.has(st.id);
                  return (
                    <label
                      key={st.id}
                      className={
                        'press flex items-center gap-2 rounded-[var(--r-utility)] px-2 py-1.5 ' +
                        (editable ? 'cursor-pointer' : 'cursor-not-allowed opacity-60')
                      }
                      title={editable ? undefined : "You don't administer this store"}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={pending || !editable}
                        onChange={(e) => {
                          if (e.target.checked) {
                            assignMut.mutate({
                              memberId: target.memberId,
                              storeId: st.id,
                            });
                          } else {
                            unassignMut.mutate({
                              memberId: target.memberId,
                              storeId: st.id,
                            });
                          }
                        }}
                      />
                      <span className="text-old-body text-[var(--c-fg)]">{st.name}</span>
                      {st.code ? (
                        <span className="text-old-label text-[var(--c-fg-muted)]">{st.code}</span>
                      ) : null}
                      {/* D2 (2026-05-06): "Transfer..." per assigned
                          row. M1.9 (2026-05-07): gated to global admins
                          only — store-scoped managers should use the
                          unassign+reassign workflow on this same grid. */}
                      {checked && editable && isGlobalAdmin ? (
                        <button
                          type="button"
                          className="ml-auto rounded-full bg-[var(--c-surface)] px-2 py-0.5 text-old-label font-medium text-[var(--c-fg)] ring-hairline active:opacity-80"
                          onClick={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            setTransferFrom({ storeId: st.id, storeName: st.name });
                          }}
                          title={i18n.t('people.transferTooltip')}
                        >
                          → {i18n.t('admin.action.transfer')}
                        </button>
                      ) : !editable ? (
                        <span className="ml-auto text-old-tiny uppercase tracking-wide text-[var(--c-fg-muted)]">
                          read-only
                        </span>
                      ) : null}
                    </label>
                  );
                })}
                {(storesQuery.data ?? []).length === 0 ? (
                  <span className="px-2 py-1 text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t('people.noStoresInOrg')}
                  </span>
                ) : null}
              </div>
            )}
            <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('people.storeScopeHint')}
            </p>
          </Field>
        </div>
      ) : null}
      {target && transferFrom ? (
        <TransferStoreSheet
          target={{
            memberId: target.memberId,
            displayName: target.displayName,
            fromStoreId: transferFrom.storeId,
            fromStoreName: transferFrom.storeName,
          }}
          onClose={() => setTransferFrom(null)}
        />
      ) : null}
    </Sheet>
  );
}

/**
 * TransferStoreSheet (D2, 2026-05-06).
 *
 * Wizard for atomically moving a member from one store to another.
 * The wizard is one screen, not multi-step:
 *   - source store name shown read-only at top
 *   - destination store: dropdown of the actor's other admin stores
 *     (filtered by `session.adminStoreIds`, exclude the source)
 *   - "Mirror role bindings" toggle (default ON) — copies every store-
 *     scoped role binding the member has in `from` to `to`. Off means
 *     the operator wants a clean break (e.g. promotion to a different
 *     role at the new location).
 *   - footer button calls memberTransferStore in one tx
 *
 * Server enforces C1 in BOTH stores and C2 (admin of both); the FE
 * filtering is just UX.
 */
function TransferStoreSheet({
  target,
  onClose,
}: {
  target: {
    memberId: string;
    displayName: string;
    fromStoreId: string;
    fromStoreName: string;
  } | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const sessionStores = session?.stores ?? [];
  const open = !!target;

  const [toStoreId, setToStoreId] = useState<string>('');
  const [mirrorRoles, setMirrorRoles] = useState(true);

  useEffect(() => {
    // Reset the form whenever the sheet is opened with a new target.
    if (target) {
      setToStoreId('');
      setMirrorRoles(true);
    }
  }, [target]);

  // Eligible destinations: stores actor admins, excluding the source
  // and (rare) inactive stores that may sneak into session.stores.
  const destinationStores = useMemo(() => {
    if (!target) return [];
    return sessionStores.filter((st) => adminStoreIds.has(st.id) && st.id !== target.fromStoreId);
  }, [sessionStores, adminStoreIds, target]);

  const transferMut = trpc.admin.memberTransferStore.useMutation({
    onSuccess: (data) => {
      void utils.admin.memberList.invalidate();
      void utils.admin.memberStoreAssignments.invalidate();
      const parts = [i18n.t('people.toastTransferred')];
      if (data.mirrored > 0) parts.push(i18n.t('people.toastRolesMirrored', { n: data.mirrored }));
      if (data.revokedBindings > 0)
        parts.push(i18n.t('people.toastFromSideRevoked', { n: data.revokedBindings }));
      toast.success(parts.join(' · '));
      onClose();
    },
    onError: errToast('common.error'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && !transferMut.isPending && onClose()}
      title={i18n.t('people.transferTitle')}
      description={target ? i18n.t('people.transferMoving', { name: target.displayName }) : ''}
      footer={
        target ? (
          <Button
            block
            size="lg"
            loading={transferMut.isPending}
            disabled={!toStoreId}
            onClick={() =>
              transferMut.mutate({
                memberId: target.memberId,
                fromStoreId: target.fromStoreId,
                toStoreId,
                mirrorRoles,
              })
            }
          >
            {i18n.t('people.transferAction')}
          </Button>
        ) : undefined
      }
    >
      {target ? (
        <div className="flex flex-col gap-3 py-3">
          {/* M1.21-C: this TransferSheet uses From/To as spatial
              labels (source store / destination store), not date
              range. Leave English here until the sheet gets its
              own dedicated i18n pass with all the other admin
              transfer copy. */}
          <Field label={i18n.t('people.transferFrom')}>
            <div className="rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 py-2 text-old-h3 ring-hairline">
              {target.fromStoreName}
            </div>
          </Field>
          <Field label={`${i18n.t('people.transferTo')} *`}>
            {destinationStores.length === 0 ? (
              <Banner tone="warn" title={i18n.t('people.transferNoDestTitle')}>
                {i18n.t('people.transferNoDestBody')}
              </Banner>
            ) : (
              <Select value={toStoreId} onChange={(e) => setToStoreId(e.target.value)}>
                <option value="">— pick a destination store —</option>
                {destinationStores.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <label className="press flex cursor-pointer items-start gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5"
              checked={mirrorRoles}
              onChange={(e) => setMirrorRoles(e.target.checked)}
            />
            <div className="min-w-0 flex-1">
              <div className="text-old-body font-semibold text-[var(--c-fg)]">
                {i18n.t('people.mirrorRoles')}
              </div>
              <p className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                {i18n.t('people.mirrorRolesHint', { store: target.fromStoreName })}
              </p>
            </div>
          </label>
          <Banner tone="info" title={i18n.t('people.transferWhatTitle')}>
            {i18n.t('people.transferWhatIntro')}
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-old-label">
              <li>{i18n.t('people.transferWhatAdded', { name: target.displayName })}</li>
              <li>
                {i18n.t(mirrorRoles ? 'people.transferWhatMirrored' : 'people.transferWhatNoRoles')}
              </li>
              <li>{i18n.t('people.transferWhatRemoved', { store: target.fromStoreName })}</li>
            </ul>
            {i18n.t('people.transferWhatOutro')}
          </Banner>
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * Per-member permission overrides editor (added 2026-05-05).
 *
 * Three layers shown for each permission key:
 *   1. Role-derived (gray, "from role" badge) — read-only baseline
 *   2. allow override   (green chip) — adds the key on top
 *   3. deny override    (red chip)   — removes the key from baseline
 *
 * UX:
 *   - Each row has a 3-state segmented control: [from role] / [allow] / [deny]
 *     "from role" = no override, fall back to baseline (which itself
 *     may be allow or none — that's fine, the badge tells you what)
 *   - Toggling allow/deny calls memberPermissionSet
 *   - Toggling back to "from role" calls memberPermissionRevoke
 *   - Effective set is shown at top as a small badge count
 */
function MemberPermissionsSheet({
  target,
  onClose,
}: {
  target: {
    memberId: string;
    displayName: string;
    /** The stores this member belongs to (for the per-store
     *  override tabs added 2026-05-06 in A2). Pass an empty
     *  array if the member is org-level. */
    stores: Array<{ id: string; name: string }>;
  } | null;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  const session = useAuthStore((s) => s.session);
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const open = !!target;
  const detail = trpc.admin.memberPermissionsList.useQuery(
    { memberId: target?.memberId ?? '' },
    { enabled: open },
  );
  const allPerms = trpc.admin.permissionList.useQuery(undefined, { enabled: open });

  /**
   * Active scope tab. 'global' is always available; store-scoped tabs
   * appear only for stores the member belongs to AND the actor admins.
   * (A store-scoped admin shouldn't see — let alone be able to edit —
   * overrides for a store they don't run; the server enforces too.)
   */
  type Scope = { kind: 'global' } | { kind: 'store'; storeId: string; storeName: string };
  const [scope, setScope] = useState<Scope>({ kind: 'global' });
  // Reset scope when sheet opens for a new target. Default to 'global'
  // so the operator lands on the familiar surface.
  useEffect(() => {
    if (target) setScope({ kind: 'global' });
  }, [target]);

  const editableStoreTabs = useMemo(
    () => (target?.stores ?? []).filter((st) => adminStoreIds.has(st.id)),
    [target, adminStoreIds],
  );

  const set = trpc.admin.memberPermissionSet.useMutation({
    onSuccess: () => {
      void utils.admin.memberPermissionsList.invalidate({
        memberId: target?.memberId ?? '',
      });
    },
    onError: errToast('common.error'),
  });
  const revoke = trpc.admin.memberPermissionRevoke.useMutation({
    onSuccess: () => {
      void utils.admin.memberPermissionsList.invalidate({
        memberId: target?.memberId ?? '',
      });
    },
    onError: errToast('common.error'),
  });

  /**
   * Index overrides by (scopeKey, permissionKey) so each tab can
   * render its own effect chip without cross-talk. The 'global' bucket
   * holds rows where override.scopeType === 'global'; each store
   * bucket holds rows where override.scopeType === 'store' AND
   * scopeId === storeId. (A2, 2026-05-06.)
   */
  const overrideByScopeKey = useMemo(() => {
    const m = new Map<string, Map<string, 'allow' | 'deny'>>();
    for (const o of detail.data?.overrides ?? []) {
      const key = o.scopeType === 'global' ? 'global' : `store:${o.scopeId ?? ''}`;
      const inner = m.get(key) ?? new Map();
      inner.set(o.permissionKey, o.effect);
      m.set(key, inner);
    }
    return m;
  }, [detail.data]);

  const currentScopeKey = scope.kind === 'global' ? 'global' : `store:${scope.storeId}`;
  const overrideByKey = overrideByScopeKey.get(currentScopeKey) ?? new Map();

  const roleKeys = useMemo(() => new Set(detail.data?.roleKeys ?? []), [detail.data]);

  const grouped = useMemo(() => {
    const m = new Map<string, Array<{ key: string; description: string | null }>>();
    for (const p of allPerms.data ?? []) {
      const ns = p.key.split('.')[0] ?? 'misc';
      const arr = m.get(ns) ?? [];
      arr.push({ key: p.key, description: p.description });
      m.set(ns, arr);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [allPerms.data]);

  const handleSet = (key: string, mode: 'role' | 'allow' | 'deny') => {
    if (!target) return;
    const scopeArgs =
      scope.kind === 'global'
        ? { scopeType: 'global' as const }
        : { scopeType: 'store' as const, scopeId: scope.storeId };
    if (mode === 'role') {
      revoke.mutate({
        memberId: target.memberId,
        permissionKey: key,
        ...scopeArgs,
      });
    } else {
      set.mutate({
        memberId: target.memberId,
        permissionKey: key,
        effect: mode,
        ...scopeArgs,
      });
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={target ? `Permissions — ${target.displayName}` : 'Permissions'}
      description={
        detail.data
          ? i18n.t('people.effectiveOverridesLine', {
              eff: detail.data.effective.length,
              ov: detail.data.overrides.length,
            })
          : undefined
      }
    >
      {detail.isLoading || allPerms.isLoading ? (
        <div className="py-8 text-center text-old-body text-[var(--c-fg-muted)]">
          <Spinner size={16} />
        </div>
      ) : !detail.data ? (
        <div className="py-8 text-center text-old-body text-[var(--c-fg-muted)]">—</div>
      ) : (
        <div className="flex flex-col gap-3 py-3">
          {/* Scope tabs (A2, 2026-05-06). 'Global' is always present;
              store tabs appear only when the member belongs to that
              store AND the actor administers it. The little dot on
              each tab counts overrides scoped to that tab. */}
          {(editableStoreTabs.length > 0 || (target?.stores ?? []).length > 0) && (
            <div className="flex flex-wrap gap-1">
              <ScopeTab
                active={scope.kind === 'global'}
                onClick={() => setScope({ kind: 'global' })}
                count={overrideByScopeKey.get('global')?.size ?? 0}
              >
                {i18n.t('people.scopeGlobal')}
              </ScopeTab>
              {(target?.stores ?? []).map((st) => {
                const editable = adminStoreIds.has(st.id);
                const isActive = scope.kind === 'store' && scope.storeId === st.id;
                const tabCount = overrideByScopeKey.get(`store:${st.id}`)?.size ?? 0;
                return (
                  <ScopeTab
                    key={st.id}
                    active={isActive}
                    disabled={!editable}
                    onClick={() =>
                      editable &&
                      setScope({
                        kind: 'store',
                        storeId: st.id,
                        storeName: st.name,
                      })
                    }
                    count={tabCount}
                    title={editable ? undefined : "You don't administer this store — read-only"}
                  >
                    {st.name}
                  </ScopeTab>
                );
              })}
            </div>
          )}
          <Banner tone="info" title={i18n.t('people.overridesHowTitle')}>
            {scope.kind === 'global'
              ? i18n.t('people.overridesHowGlobal')
              : i18n.t('people.overridesHowStore', { store: scope.storeName })}
          </Banner>
          {grouped.map(([ns, keys]) => (
            <div key={ns}>
              <SectionLabel padded={false}>{ns}</SectionLabel>
              <ul className="mt-1 flex flex-col gap-1">
                {keys.map((p) => {
                  const override = overrideByKey.get(p.key) ?? null;
                  const fromRole = roleKeys.has(p.key);
                  const mode: 'role' | 'allow' | 'deny' = override ?? 'role';
                  return (
                    <li
                      key={p.key}
                      className="flex flex-col gap-1 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-mono text-old-label">{p.key}</div>
                          {p.description ? (
                            <div className="mt-0.5 text-old-label text-[var(--c-fg-muted)]">
                              {p.description}
                            </div>
                          ) : null}
                        </div>
                        {fromRole ? <Badge tone="muted">from role</Badge> : null}
                      </div>
                      {/* M3.17 (2026-05-16): migrated from local SegBtn
                          to the shared <Segmented> primitive. Per-option
                          activeBg drives the allow=green / deny=red /
                          inherit=action coloring that the old SegBtn
                          baked in via a `tone` prop. */}
                      <Segmented<'role' | 'allow' | 'deny'>
                        size="sm"
                        value={mode}
                        options={[
                          { value: 'role', label: 'From role' },
                          {
                            value: 'allow',
                            label: 'Allow',
                            activeBg: 'bg-[var(--c-success)]',
                          },
                          {
                            value: 'deny',
                            label: 'Deny',
                            activeBg: 'bg-[var(--c-danger)]',
                          },
                        ]}
                        onChange={(next) => handleSet(p.key, next)}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/**
 * ScopeTab — tab pill for the per-store permission-override tabs (A2,
 * 2026-05-06). Mirrors the visual language of the segmented buttons
 * but in tab-bar form. Shows a small count chip when the tab has at
 * least one override scoped to it. `disabled` greys it out for stores
 * the actor doesn't administer (the tab still renders so the operator
 * sees the full member-store list, but it's read-only-style).
 */
function ScopeTab({
  active,
  disabled,
  count,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  count?: number;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const base =
    'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-old-label font-medium ring-hairline';
  const tone = active
    ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
    : disabled
      ? 'bg-transparent text-[var(--c-fg-muted)] opacity-60'
      : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]';
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${tone}`}
    >
      <span>{children}</span>
      {count && count > 0 ? (
        <span
          className={
            'inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-old-tiny ' +
            (active ? 'bg-white/25 text-white' : 'bg-[var(--c-action)] text-[var(--c-action-fg)]')
          }
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

// M3.17 (2026-05-16): the local SegBtn helper was retired — both
// callers (Permissions matrix + Grant Role scope) now use the shared
// <Segmented> primitive from @compass/ui.

// ADMIN_RANK is imported from `@compass/contracts` (see top of file).
// Single source of truth for the org-tier threshold — the M1.5 audit
// found this constant duplicated in 4 places (server gate + 3 FE
// usages) which was a drift hazard.

/**
 * GrantRoleSheet — two-step picker.
 *
 *   Step 1: pick scope.
 *     - "Globally"     → only org-tier roles (rank ≥ 80). Hidden if the
 *                        actor is a store-scoped admin only (their
 *                        adminStoreIds doesn't cover the whole org).
 *     - "In specific store(s)" → store-tier roles (rank < 80). The
 *                        store dropdown is filtered to session.adminStoreIds
 *                        — a store-scoped admin only sees their own stores.
 *
 *   Step 2: pick role.
 *     - Filtered to roles whose rank < the actor's effective rank IN
 *       the chosen scope. For "store" scope with multiple stores
 *       selected, we use the MIN rank across the selected stores
 *       (because each store-binding is independently gated server-side
 *       — if any one fails, the operation aborts mid-way).
 *
 *   When a role is tapped:
 *     - Global → 1 grantRole call
 *     - Store(s) → N grantRole calls in sequence (one per selected
 *                  store). Server's idempotency check makes re-runs safe.
 *
 * Defaults: if the caller passes `defaultStoreId` (PeopleSection does
 * this when StoreSwitcher is in 'specific' mode), we pre-select store
 * scope + that store so the operator doesn't have to re-pick.
 */
function GrantRoleSheet({
  target,
  onClose,
}: {
  target: { userId: string; displayName: string; defaultStoreId?: string | null } | null;
  onClose: () => void;
}) {
  const session = useAuthStore((s) => s.session);
  const myGlobalMaxRank = session?.myMaxRank ?? 0;
  const storeRanks = session?.storeRanks ?? {};
  const adminStoreIds = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const sessionStores = session?.stores ?? [];
  const i18n = useI18n();

  const rolesQuery = trpc.admin.roleList.useQuery(undefined, { enabled: !!target });
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const grant = trpc.admin.grantRole.useMutation({
    onError: errToast('common.error'),
  });

  // Two-step state.
  const [scopeMode, setScopeMode] = useState<'global' | 'store'>('store');
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(new Set());

  // Reset state when the target changes (sheet opens for a new member).
  useEffect(() => {
    if (!target) return;
    if (target.defaultStoreId && adminStoreIds.has(target.defaultStoreId)) {
      setScopeMode('store');
      setSelectedStoreIds(new Set([target.defaultStoreId]));
    } else {
      setScopeMode('store');
      setSelectedStoreIds(new Set());
    }
  }, [target, adminStoreIds]);

  // C2: stores the actor can administer, intersected with the org's
  // store list (so we always render fresh names).
  const eligibleStores = useMemo(
    () => sessionStores.filter((s) => adminStoreIds.has(s.id)),
    [sessionStores, adminStoreIds],
  );

  // Whether the actor can grant a 'global' (org-tier) binding. Mirrors
  // the server: only true if the actor is admin EVERYWHERE (their
  // adminStoreIds covers every active store the session sees). For a
  // store-scoped admin, adminStoreIds is a subset, so this is false.
  const canGrantGlobal = useMemo(() => {
    if (sessionStores.length === 0) return adminStoreIds.size > 0; // edge: org-admin without stores
    return sessionStores.every((s) => adminStoreIds.has(s.id));
  }, [sessionStores, adminStoreIds]);

  // Effective rank in the chosen scope.
  //   global → myGlobalMaxRank (the actor's overall max)
  //   store  → min over selected stores of max(globalMax, storeRanks[id])
  // We use MIN because the grant fans out to N independent server
  // calls, each gated on its own store rank — the weakest link wins.
  const effectiveRank = useMemo(() => {
    if (scopeMode === 'global') return myGlobalMaxRank;
    if (selectedStoreIds.size === 0) return 0;
    let min = Infinity;
    for (const id of selectedStoreIds) {
      const r = Math.max(myGlobalMaxRank, storeRanks[id] ?? 0);
      if (r < min) min = r;
    }
    return min === Infinity ? 0 : min;
  }, [scopeMode, selectedStoreIds, myGlobalMaxRank, storeRanks]);

  /**
   * Filter roles. Three rules combined:
   *   1. rank < effectiveRank (the existing "no equal/higher grants" rule)
   *   2. scopeMode='global' → only org-tier roles (rank ≥ ADMIN_RANK)
   *   3. scopeMode='store'  → only store-tier roles (rank < ADMIN_RANK)
   * Server enforces the same — this just gives the FE a clean picker.
   */
  const grantableRoles = useMemo(() => {
    return [...(rolesQuery.data ?? [])]
      .filter((r) => r.rank < effectiveRank)
      .filter((r) => (scopeMode === 'global' ? r.rank >= ADMIN_RANK : r.rank < ADMIN_RANK))
      .sort((a, b) => b.rank - a.rank);
  }, [rolesQuery.data, effectiveRank, scopeMode]);

  const toggleStore = (id: string) => {
    setSelectedStoreIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePick = async (slug: string) => {
    if (!target) return;
    if (scopeMode === 'global') {
      try {
        const data = await grant.mutateAsync({
          userId: target.userId,
          roleSlug: slug,
          scopeType: 'global',
        });
        toast[data.granted ? 'success' : 'info'](
          i18n.t(data.granted ? 'people.toastRoleGranted' : 'people.toastRoleAlready'),
        );
        void utils.admin.memberList.invalidate();
        onClose();
      } catch {
        /* error toast already shown */
      }
      return;
    }
    // Store fan-out. We loop sequentially so a mid-run server error
    // (rank changed, store archived, etc.) leaves the partial result
    // visible to the user and they can retry the rest.
    let createdCount = 0;
    let skipped = 0;
    for (const storeId of selectedStoreIds) {
      try {
        const data = await grant.mutateAsync({
          userId: target.userId,
          roleSlug: slug,
          scopeType: 'store',
          scopeId: storeId,
        });
        if (data.granted) createdCount++;
        else skipped++;
      } catch {
        // first failure: stop here; toast already raised by onError
        void utils.admin.memberList.invalidate();
        return;
      }
    }
    if (createdCount > 0) {
      toast.success(
        i18n.t('people.toastGrantedInStores', { n: createdCount }) +
          (skipped > 0 ? ` ${i18n.t('people.toastAlreadyHad', { n: skipped })}` : ''),
      );
    } else if (skipped > 0) {
      toast.info(i18n.t('people.toastAlreadyEverywhere'));
    }
    void utils.admin.memberList.invalidate();
    onClose();
  };

  const canSubmit = scopeMode === 'global' ? canGrantGlobal : selectedStoreIds.size > 0;

  return (
    <KitSheet
      open={!!target}
      onOpenChange={(open) => !open && !grant.isPending && onClose()}
      title={target ? i18n.t('people.grantRoleTo', { name: target.displayName }) : ''}
    >
      <div className="flex flex-col gap-xl">
        {/* Where the role holds. "Every store" is only offered to someone
            who administers every store; the server checks the same. */}
        <div className="flex flex-col gap-sm">
          <span className="text-label text-ink">{i18n.t('admin.field.scope')}</span>
          <div className="flex flex-wrap gap-sm">
            <button
              type="button"
              aria-pressed={scopeMode === 'store'}
              data-testid="grant-scope-store"
              onClick={() => setScopeMode('store')}
              className={capsule(scopeMode === 'store')}
            >
              {i18n.t('people.grantInStores')}
            </button>
            <button
              type="button"
              aria-pressed={scopeMode === 'global'}
              data-testid="grant-scope-global"
              disabled={!canGrantGlobal}
              onClick={() => setScopeMode('global')}
              className={capsule(scopeMode === 'global')}
            >
              {i18n.t('people.everyStore')}
            </button>
          </div>
          {!canGrantGlobal ? (
            <p className="text-small text-secondary">{i18n.t('people.globalGrantLockedHint')}</p>
          ) : null}
        </div>

        {scopeMode === 'store' ? (
          <div className="flex flex-col gap-sm">
            <span className="text-label text-ink">{i18n.t('admin.field.stores')}</span>
            {eligibleStores.length === 0 ? (
              <div role="status" className="rounded-lg bg-warning-pale p-xl">
                <p className="text-label text-warning-ink">{i18n.t('people.noGrantStoresTitle')}</p>
                <p className="text-small text-warning-ink">{i18n.t('people.noGrantStoresBody')}</p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-sm">
                {eligibleStores.map((st) => (
                  <button
                    key={st.id}
                    type="button"
                    aria-pressed={selectedStoreIds.has(st.id)}
                    data-testid="grant-store"
                    onClick={() => toggleStore(st.id)}
                    className={capsule(selectedStoreIds.has(st.id))}
                  >
                    {st.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* The roles this person may be given there. Tapping one grants it. */}
        <div className="flex flex-col gap-sm">
          <span className="text-label text-ink">{i18n.t('people.roles')}</span>
          {!canSubmit ? (
            <p className="text-small text-secondary">{i18n.t('people.pickScopeFirst')}</p>
          ) : rolesQuery.isLoading ? (
            <p className="text-small text-secondary">{i18n.t('admin.label.loadingRoles')}</p>
          ) : grantableRoles.length === 0 ? (
            <div role="status" className="rounded-lg bg-warning-pale p-xl">
              <p className="text-label text-warning-ink">{i18n.t('people.noGrantableTitle')}</p>
              <p className="text-small text-warning-ink">
                {scopeMode === 'global'
                  ? i18n.t('people.noGrantableGlobal', { rank: effectiveRank })
                  : i18n.t('people.noGrantableStore', { rank: effectiveRank })}
              </p>
            </div>
          ) : (
            grantableRoles.map((r) => (
              <button
                key={r.id}
                type="button"
                data-testid="grant-role"
                disabled={grant.isPending}
                onClick={() => void handlePick(r.slug)}
                className="flex min-h-row items-center gap-lg py-sm text-start outline-none active:opacity-60 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-ink">{r.name}</span>
                  {r.description ? (
                    <span className="block text-small text-secondary">{r.description}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-forest">
                  <ChevronIcon />
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </KitSheet>
  );
}
