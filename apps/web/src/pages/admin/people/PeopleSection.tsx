import { useMemo, useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  CardHeader,
  CardMeta,
  CardTitle,
  DataState,
  EmptyState,
  ListRow,
  SearchInput,
  SectionLabel,
  Sheet,
  useToast,
  rowGroupClass,
} from '@compass/ui';
import { STALE } from '../../../config/timings';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { copyText } from '../../../lib/clipboard';
import { useErrToast } from '../../../hooks/useErrToast';
import { matchesAnyString, normalizeQuery } from '../../../lib/searchMatch';
import { useDateFormat, useI18n, useRoleLabels } from '../../../hooks/useI18n';
import { useIsOrgAdmin } from '../../../hooks/useAdminAuthority';
import { getTg } from '../../../lib/telegram';
import {
  inviteLink as makeInviteLink,
  shareLink as makeShareLink,
} from '../../../lib/telegramLinks';
import { nativeConfirm } from '../shared';
import { InviteCopySheet } from './InviteCopySheet';
import {
  canDetachFromStore,
  canGrantTo,
  canGrantToMember,
  canRemoveFromOrg,
  canRevokeRole,
  canSetOverride,
  canSetStatus,
  type TargetMember,
} from '../../../lib/authority';
import { InviteHubSheet } from './invite/InviteHubSheet';
import { ManualInviteSheet } from './invite/ManualInviteSheet';
import { GrantRoleSheet } from './members/GrantRoleSheet';
import { ManageMemberSheet } from './members/ManageMemberSheet';
import { MemberPermissionsSheet } from './members/MemberPermissionsSheet';
import { type InviteDraft, targetOf, useActor } from './shared';

/**
 * PeopleSection — directory of org members, inside a store's Team tab:
 *
 *   - **`lockMode={ kind: 'store', storeId }`** (M1.4): only members
 *     of this store. The screen lives inside StoreDetailScreen, so the
 *     parent establishes the store, not the StoreSwitcher.
 *
 *   - **`lockMode={ kind: 'org-level' }`** (M1.4): only members with no
 *     store (organisation-level operators). Used by the Stores →
 *     Org-level pseudo-store entry.
 *
 * Review ADM1-27 (2026-11-12): the mode without `lockMode`, which
 * followed the StoreSwitcher and grouped everyone by store, had no
 * caller since M1.4 and is gone.
 */
export function PeopleSection({
  lockMode,
}: {
  lockMode: { kind: 'store'; storeId: string } | { kind: 'org-level' };
}) {
  const session = useAuthStore((s) => s.session);
  const membersQuery = trpc.admin.memberList.useQuery();
  const actor = useActor(membersQuery.data);
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const roleText = useRoleLabels();
  const dateFmt = useDateFormat();
  // M1.9: per-key allow/deny override grid is power-user surface — gate
  // the "Permissions" button to global admins only. The 4 built-in
  // roles cover the common cases that store-scoped managers need.
  // Managing every store currently visible in a session is not the same as
  // organization-wide authority (a single-store manager satisfies that old
  // test). Permission overrides are global-impact tooling, so gate them on
  // the explicit organization marker.
  const isGlobalAdminPeople = useIsOrgAdmin();
  const storeCtx =
    lockMode.kind === 'store'
      ? { kind: 'specific' as const, storeId: lockMode.storeId }
      : { kind: 'org-level' as const };
  // Note: the previous internal tabs (Members | Roles) are gone — Roles
  // & Permissions is now its own top-level sub-section under People.
  // This screen is purely the members directory.
  const [grantFor, setGrantFor] = useState<{
    userId: string;
    displayName: string;
    defaultStoreId?: string | null;
    member: TargetMember;
  } | null>(null);
  const [manageFor, setManageFor] = useState<{
    memberId: string;
    userId: string;
    displayName: string;
    member: TargetMember;
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
    member: TargetMember;
  } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [manualDraft, setManualDraft] = useState<InviteDraft | null>(null);
  const [linkDraft, setLinkDraft] = useState<InviteDraft | null>(null);
  const [linkAction, setLinkAction] = useState<'share' | 'copy'>('share');
  // M1.11: per-member overflow menu (Permissions / Suspend / Reactivate /
  // Remove-from-store / Remove-from-org). Demotes a 5–6-button action
  // strip — which was wrapping onto two rows on a 390px-wide iPhone — to
  // a single ⋯ button, opening a Sheet with the conditional rows below.
  // Shape mirrors the member row so every conditional in the old strip
  // still works without extra queries.
  const [memberMenuFor, setMemberMenuFor] = useState<{
    memberId: string;
    userId: string;
    displayName: string;
    status: 'active' | 'suspended';
    stores: Array<{ id: string; name: string }>;
    /** ADM1-16: paused and archived stores; the member can only leave them. */
    inactiveStores: Array<{ id: string; name: string }>;
    isSelf: boolean;
    member: TargetMember;
    /** DX-ADM-11: the roles this person may take away, with a name for each. */
    revocable: Array<{ bindingId: string; role: string; store: string | null }>;
  } | null>(null);

  const setStatus = trpc.admin.memberSetStatus.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.info(i18n.t('admin.toast.memberUpdated'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const remove = trpc.admin.memberRemove.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.success(i18n.t('admin.toast.memberRemoved'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const revoke = trpc.admin.revokeRole.useMutation({
    onSuccess: () => {
      void utils.admin.memberList.invalidate();
      toast.info(i18n.t('admin.toast.roleRevoked'));
    },
    onError: errToast('common.errors.actionFailed'),
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
    onError: errToast('common.errors.actionFailed'),
  });
  const invite = trpc.admin.memberInviteByTgId.useMutation({
    onSuccess: (data) => {
      void utils.admin.memberList.invalidate();
      toast[data.created ? 'success' : 'info'](
        data.created ? i18n.t('admin.toast.memberAdded') : i18n.t('admin.toast.userExists'),
      );
      setManualDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const appConfig = trpc.system.appConfig.useQuery(undefined, {
    staleTime: STALE.long,
  });
  const createInvite = trpc.admin.memberInviteCreate.useMutation({
    onSuccess: () => void utils.admin.memberInviteList.invalidate(),
    onError: errToast('common.errors.actionFailed'),
  });
  // ADM1-15: an invite the clipboard refused, shown to copy by hand. The
  // server keeps no copy of the token, so it can't be fetched again.
  const [uncopiedInvite, setUncopiedInvite] = useState<string | null>(null);
  /**
   * Creates a link invite, then copies or shares it. ADM1-15 (2026-11-11):
   * the copy is asked for here, inside the tap, and filled in when the
   * link arrives; WebKit (Telegram on iOS) refused the write that waited
   * for the server (lib/clipboard).
   */
  const sendLinkInvite = (input: { roleSlug?: string; storeIds: string[] }) => {
    const NO_BOT = 'people.inviteNoBot';
    const invite = createInvite.mutateAsync(input).then((data) => {
      const link = makeInviteLink(appConfig.data?.botUsername, data.token);
      if (!link) throw new Error(NO_BOT);
      const message = i18n.t('people.inviteMessage', { org: session?.member.orgName ?? '' });
      return { link, message, text: `${message}\n${link}` };
    });
    const failed = (err: unknown) => {
      // A refused create was already reported by the mutation's onError.
      if (err instanceof Error && err.message === NO_BOT) toast.error(i18n.t(NO_BOT));
    };
    if (linkAction === 'copy') {
      const text = invite.then((sent) => sent.text);
      void copyText(text).then((copied) => {
        setLinkDraft(null);
        if (copied) toast.success(i18n.t('admin.toast.linkCopied'));
        else void text.then(setUncopiedInvite);
      }, failed);
      return;
    }
    void invite.then(({ link, message }) => {
      const shareUrl = makeShareLink({ url: link, text: message });
      const tg = getTg();
      if (tg) {
        tg.openTelegramLink(shareUrl);
      } else if (typeof window !== 'undefined') {
        window.open(shareUrl, '_blank');
      }
      setLinkDraft(null);
    }, failed);
  };

  // M1.10 (2026-05-08): people directory search by name + tg + role.
  const [searchQuery, setSearchQuery] = useState('');
  const tokens = useMemo(() => normalizeQuery(searchQuery), [searchQuery]);

  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <SearchInput
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onClear={() => setSearchQuery('')}
          placeholder={i18n.t('admin.search.peoplePlaceholder')}
          clearAriaLabel={i18n.t('common.clear')}
          className="flex-1"
        />
        {/* md: the same 44px as the search field beside it (D18). */}
        <Button className="shrink-0" onClick={() => setInviteOpen(true)}>
          {i18n.t('admin.action.invite')}
        </Button>
      </div>

      <DataState
        query={membersQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('admin.empty.members.title')}
            description={i18n.t('admin.empty.members.description')}
          />
        }
      >
        {(rawRows) => {
          // Apply search across displayName + tgUsername + role slugs/names.
          // Then the existing storeCtx-based filtering takes over below.
          const rows = tokens
            ? rawRows.filter((m) =>
                matchesAnyString(
                  [
                    m.displayName,
                    m.tgUsername,
                    ...m.roles.map((r) => r.slug),
                    ...m.roles.map((r) => r.name),
                    ...m.roles.map((r) => roleText.name(r)),
                  ],
                  tokens,
                ),
              )
            : rawRows;
          // ADM1-16: paused and archived stores are named and marked.
          // A role in one used to lose its store name, and the revoke
          // list called it organisation-wide.
          const inactiveName = (st: { name: string; archived: boolean }) =>
            `${st.name} · ${i18n.t(st.archived ? 'stores.archived' : 'stores.paused')}`;
          const storeNameOf = (m: (typeof rows)[number], storeId: string) => {
            const active = m.stores.find((st) => st.id === storeId);
            if (active) return active.name;
            const inactive = m.inactiveStores.find((st) => st.id === storeId);
            return inactive ? inactiveName(inactive) : null;
          };
          // Filter / group by store context (added 2026-05-05).
          // Review ADM1-23 (2026-11-12): one card, a row per member divided
          // by hairlines (UI-6); it was a card per member.
          const renderRow = (m: (typeof rows)[number]) => {
            const isSelf = m.userId === session?.user.id;
            return (
              <li key={m.memberId} className="min-w-0">
                <CardHeader>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar src={m.avatarUrl} name={m.displayName} size={36} />
                    <div className="min-w-0">
                      <CardTitle>
                        {m.displayName}
                        {/* 2026-07-30 (flow review): these four strings were
                            English literals even though admin.label.you /
                            .noTelegram / .neverSeen have existed in all four
                            catalogs for months — translated and wired up
                            nowhere. The date also read the browser locale. */}
                        {isSelf ? ` · ${i18n.t('admin.label.you')}` : ''}
                      </CardTitle>
                      <CardMeta>
                        {m.tgUsername ? `@${m.tgUsername}` : i18n.t('admin.label.noTelegram')}
                        {m.lastSeenAt
                          ? ` · ${i18n.t('admin.label.seen', {
                              date: dateFmt.date(m.lastSeenAt),
                            })}`
                          : ` · ${i18n.t('admin.label.neverSeen')}`}
                      </CardMeta>
                    </div>
                  </div>
                  {/* UIUX-B1: 'active' is the silent default (L1 — no
                      unearned green); only the exception renders. */}
                  {m.status !== 'active' ? (
                    <Badge tone="warn">
                      {m.status === 'suspended' || m.status === 'invited'
                        ? i18n.t(`people.memberStatus.${m.status}`)
                        : m.status}
                    </Badge>
                  ) : null}
                </CardHeader>
                {/* Store-affiliation chips (added 2026-05-05). Empty
                    array is rendered as "no store" hint so admins can
                    spot org-level members at a glance.
                    M3.17 (2026-05-16): inline pill spans → <Badge>.
                    Same visual rhythm as the "active" status badge in
                    the header above. Paused and archived stores follow,
                    muted, as on the store list (ADM1-16). */}
                {m.stores.length > 0 || m.inactiveStores.length > 0 ? (
                  <div className="flex flex-wrap gap-1 px-4 pt-2 pb-1">
                    {m.stores.map((st) => (
                      <Badge key={st.id} tone="info">
                        {st.name}
                      </Badge>
                    ))}
                    {m.inactiveStores.map((st) => (
                      <Badge key={st.id} tone="muted">
                        {inactiveName(st)}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {/* M1.11: dropped the "no store · org-level" hint row
                    (technical jargon) AND the "No roles" empty strip.
                    The chip container only renders when there are
                    actual chips to show — empty cards no longer waste
                    a row of muted-fg label space. */}
                {m.roles.length > 0 ? (
                  <div className="flex flex-wrap gap-1 px-4">
                    {
                      // Per-store role chips (added 2026-05-06). For
                      // scope='store' we suffix the store's name so the
                      // operator can tell "Manager of Store A" apart from
                      // "Manager of Store B" at a glance. Global bindings
                      // render as just the role name (no scope label).
                      m.roles.map((r) => {
                        const scopedStoreName =
                          r.scopeType === 'store' && r.scopeId ? storeNameOf(m, r.scopeId) : null;
                        // DX-ADM-11 (2026-11-01): the chip is a label only.
                        // Revoking was a tap on this 18 px chip, with the verb
                        // only in a tooltip; it now sits in the member's ⋯
                        // sheet as a full-size "Revoke" button per role.
                        // ADM1-23: the kit's Badge, not a hand-drawn pill.
                        return (
                          <Badge key={r.bindingId} tone="info" className="max-w-full">
                            <span className="min-w-0 truncate font-semibold text-[var(--c-fg)]">
                              {roleText.name(r)}
                            </span>
                            {scopedStoreName ? (
                              <span className="min-w-0 truncate">· {scopedStoreName}</span>
                            ) : null}
                          </Badge>
                        );
                      })
                    }
                  </div>
                ) : null}
                {/* M1.11: action row demoted from 5–6 buttons (which
                    wrapped onto 2 lines on a 390px iPhone) to two
                    primary inline actions + a ⋯ overflow trigger.
                    Permissions / Suspend / Reactivate / Remove-store /
                    Remove-org all live in the member-menu sheet at the
                    page level (state: memberMenuFor). */}
                <div className="flex items-center gap-2 px-4 pt-2 pb-3">
                  <Button
                    size="sm"
                    variant="pearl"
                    onClick={() =>
                      setManageFor({
                        memberId: m.memberId,
                        userId: m.userId,
                        displayName: m.displayName,
                        member: targetOf(m),
                      })
                    }
                  >
                    {i18n.t('admin.action.manage')}
                  </Button>
                  {/* ADM1-08: not on one's own card, nor on a suspended
                      member's or a peer's (canGrantToMember). */}
                  {canGrantToMember(actor, { ...targetOf(m), active: m.status === 'active' }) ? (
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() =>
                        setGrantFor({
                          userId: m.userId,
                          displayName: m.displayName,
                          // When the StoreSwitcher is on a specific store, pre-
                          // select that store in the grant sheet (A1, 2026-05-06).
                          // 'all' / 'none' kinds leave the picker empty so the
                          // operator picks consciously.
                          defaultStoreId:
                            storeCtx.kind === 'specific' &&
                            canGrantTo(actor, targetOf(m), {
                              type: 'store',
                              storeId: storeCtx.storeId,
                            })
                              ? storeCtx.storeId
                              : null,
                          member: targetOf(m),
                        })
                      }
                    >
                      {i18n.t('admin.action.grantRole')}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="pearl"
                    aria-label={i18n.t('admin.action.moreActions')}
                    onClick={() =>
                      setMemberMenuFor({
                        memberId: m.memberId,
                        userId: m.userId,
                        displayName: m.displayName,
                        status: m.status as 'active' | 'suspended',
                        stores: m.stores.map((st) => ({ id: st.id, name: st.name })),
                        inactiveStores: m.inactiveStores.map((st) => ({
                          id: st.id,
                          name: inactiveName(st),
                        })),
                        isSelf,
                        member: targetOf(m),
                        revocable: m.roles
                          .filter((r) => canRevokeRole(actor, m.userId, r))
                          .map((r) => ({
                            bindingId: r.bindingId,
                            role: roleText.name(r),
                            store:
                              r.scopeType === 'store' && r.scopeId
                                ? storeNameOf(m, r.scopeId)
                                : null,
                          })),
                      })
                    }
                  >
                    ⋯
                  </Button>
                </div>
              </li>
            );
          };

          // DX-ADM-7 (2026-11-01): a search with no match said "no members
          // in this store yet". It now says nothing matched, with a way back.
          const noMatch = (
            <EmptyState
              title={i18n.t('people.searchNoMatch', { q: searchQuery.trim() })}
              action={
                <Button variant="pearl" onClick={() => setSearchQuery('')}>
                  {i18n.t('people.clearSearch')}
                </Button>
              }
            />
          );

          // Specific store: only show members assigned there.
          if (storeCtx.kind === 'specific') {
            // A paused store's page lists its people too (ADM1-16).
            const filtered = rows.filter((m) =>
              [...m.stores, ...m.inactiveStores].some((s) => s.id === storeCtx.storeId),
            );
            if (filtered.length === 0 && tokens) return noMatch;
            if (filtered.length === 0) {
              return (
                <EmptyState
                  title={i18n.t('admin.empty.noStoresInThisStore.title')}
                  description={i18n.t('admin.empty.noStoresInThisStore.description')}
                />
              );
            }
            return (
              <ul className={rowGroupClass} role="list">
                {filtered.map(renderRow)}
              </ul>
            );
          }

          // M1.4: org-level pseudo-store. Show only members with no
          // store assignments (admin / super_admin operators).
          const orgOnly = rows.filter(
            (m) => m.stores.length === 0 && m.inactiveStores.length === 0,
          );
          if (orgOnly.length === 0 && tokens) return noMatch;
          if (orgOnly.length === 0) {
            return (
              <EmptyState
                title={i18n.t('people.orgLevelEmptyTitle')}
                description={i18n.t('people.orgLevelEmptyBody')}
              />
            );
          }
          return (
            <ul className={rowGroupClass} role="list">
              {orgOnly.map(renderRow)}
            </ul>
          );
        }}
      </DataState>

      <GrantRoleSheet actor={actor} target={grantFor} onClose={() => setGrantFor(null)} />
      <ManageMemberSheet actor={actor} target={manageFor} onClose={() => setManageFor(null)} />
      <MemberPermissionsSheet actor={actor} target={permsFor} onClose={() => setPermsFor(null)} />

      {/* M1.11: per-member overflow menu. Houses the conditional
          actions that used to live as inline buttons in each card's
          action strip. Visibility rules mirror the prior conditionals
          1:1 — no behavior change, just spatial demotion. */}
      <Sheet
        open={memberMenuFor !== null}
        onOpenChange={(o) => !o && setMemberMenuFor(null)}
        title={memberMenuFor?.displayName ?? ''}
      >
        {memberMenuFor ? (
          <div className="flex flex-col gap-2 py-3">
            {memberMenuFor.revocable.length > 0 ? (
              <section aria-label={i18n.t('people.rolesOfMember')} className="mb-1">
                <SectionLabel as="h3" padded={false} className="mb-1">
                  {i18n.t('people.rolesOfMember')}
                </SectionLabel>
                <ul className={rowGroupClass} role="list">
                  {memberMenuFor.revocable.map((r) => (
                    <li key={r.bindingId}>
                      <ListRow
                        label={r.role}
                        hint={r.store ?? i18n.t('people.orgLevelLabel')}
                        trailing={
                          <Button
                            variant="danger"
                            disabled={revoke.isPending}
                            aria-label={
                              r.store
                                ? i18n.t('people.revokeRoleInStoreAria', {
                                    role: r.role,
                                    store: r.store,
                                    name: memberMenuFor.displayName,
                                  })
                                : i18n.t('people.revokeRoleAria', {
                                    role: r.role,
                                    name: memberMenuFor.displayName,
                                  })
                            }
                            onClick={() => {
                              const name = memberMenuFor.displayName;
                              setMemberMenuFor(null);
                              nativeConfirm(
                                r.store
                                  ? i18n.t('people.revokeRoleInStoreConfirm', {
                                      role: r.role,
                                      store: r.store,
                                      name,
                                    })
                                  : i18n.t('people.revokeRoleConfirm', { role: r.role, name }),
                                () => revoke.mutate({ bindingId: r.bindingId }),
                              );
                            }}
                          >
                            {i18n.t('people.revokeRole')}
                          </Button>
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {isGlobalAdminPeople &&
            (canSetOverride(actor, memberMenuFor.member, null) ||
              memberMenuFor.stores.some((st) =>
                canSetOverride(actor, memberMenuFor.member, st.id),
              )) ? (
              <Button
                block
                variant="pearl"
                onClick={() => {
                  const target = memberMenuFor;
                  setMemberMenuFor(null);
                  setPermsFor({
                    memberId: target.memberId,
                    displayName: target.displayName,
                    stores: target.stores,
                    member: target.member,
                  });
                }}
              >
                {i18n.t('admin.action.permissions')}
              </Button>
            ) : null}
            {!memberMenuFor.isSelf &&
            memberMenuFor.status === 'active' &&
            canSetStatus(actor, memberMenuFor.member, 'suspended') ? (
              <Button
                block
                variant="pearl"
                onClick={() => {
                  const target = memberMenuFor;
                  setMemberMenuFor(null);
                  nativeConfirm(i18n.t('admin.confirm.suspend', { name: target.displayName }), () =>
                    setStatus.mutate({ memberId: target.memberId, status: 'suspended' }),
                  );
                }}
              >
                {i18n.t('admin.action.suspend')}
              </Button>
            ) : null}
            {!memberMenuFor.isSelf &&
            memberMenuFor.status === 'suspended' &&
            canSetStatus(actor, memberMenuFor.member, 'active') ? (
              <Button
                block
                variant="pearl"
                onClick={() => {
                  const target = memberMenuFor;
                  setMemberMenuFor(null);
                  setStatus.mutate({ memberId: target.memberId, status: 'active' });
                }}
              >
                {i18n.t('admin.action.reactivate')}
              </Button>
            ) : null}
            {/* D1 (2026-05-06): "Remove from this store" — visible
                only when the StoreSwitcher is on a single store AND
                the member belongs to it. */}
            {!memberMenuFor.isSelf &&
            storeCtx.kind === 'specific' &&
            [...memberMenuFor.stores, ...memberMenuFor.inactiveStores].some(
              (st) => st.id === storeCtx.storeId,
            ) &&
            canDetachFromStore(actor, memberMenuFor.member, storeCtx.storeId) ? (
              <Button
                block
                variant="pearl"
                onClick={() => {
                  if (storeCtx.kind !== 'specific') return;
                  const target = memberMenuFor;
                  const storeName =
                    [...target.stores, ...target.inactiveStores].find(
                      (st) => st.id === storeCtx.storeId,
                    )?.name ?? i18n.t('admin.label.thisStore');
                  setMemberMenuFor(null);
                  nativeConfirm(
                    i18n.t('admin.confirm.removeFromStore', {
                      name: target.displayName,
                      store: storeName,
                    }),
                    () =>
                      detachFromStore.mutate({
                        memberId: target.memberId,
                        storeId: storeCtx.storeId,
                      }),
                  );
                }}
              >
                {i18n.t('admin.action.removeFromStore')}
              </Button>
            ) : null}
            {/* 2026-10-21 audit CA-16: memberRemove is org.admin only;
                ADM1-07: and only on someone they outrank. */}
            {canRemoveFromOrg(actor, memberMenuFor.member) ? (
              <Button
                block
                variant="danger"
                onClick={() => {
                  const target = memberMenuFor;
                  setMemberMenuFor(null);
                  nativeConfirm(
                    i18n.t('admin.confirm.removeFromOrg', { name: target.displayName }),
                    () => remove.mutate({ memberId: target.memberId }),
                  );
                }}
              >
                {i18n.t('admin.action.removeFromOrg')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Sheet>
      <InviteHubSheet
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onPickManual={() => {
          setInviteOpen(false);
          setManualDraft({
            tgUserId: '',
            displayName: '',
            roleSlug: '',
            storeIds: storeCtx.kind === 'specific' ? [storeCtx.storeId] : [],
          });
        }}
        onPickLink={(action) => {
          setInviteOpen(false);
          setLinkAction(action);
          setLinkDraft({
            tgUserId: '',
            displayName: '',
            roleSlug: '',
            storeIds: storeCtx.kind === 'specific' ? [storeCtx.storeId] : [],
          });
        }}
      />
      <ManualInviteSheet
        mode="tgid"
        actor={actor}
        draft={manualDraft}
        setDraft={setManualDraft}
        onSubmit={() => {
          if (!manualDraft) return;
          invite.mutate({
            tgUserId: manualDraft.tgUserId.trim(),
            displayName: manualDraft.displayName || undefined,
            roleSlug: manualDraft.roleSlug || undefined,
            storeIds: manualDraft.storeIds,
          });
        }}
        pending={invite.isPending}
      />
      <ManualInviteSheet
        mode="link"
        actor={actor}
        draft={linkDraft}
        setDraft={setLinkDraft}
        onSubmit={() => {
          if (!linkDraft) return;
          sendLinkInvite({
            roleSlug: linkDraft.roleSlug || undefined,
            storeIds: linkDraft.storeIds,
          });
        }}
        pending={createInvite.isPending}
      />
      <InviteCopySheet text={uncopiedInvite} onClose={() => setUncopiedInvite(null)} />
    </div>
  );
}
