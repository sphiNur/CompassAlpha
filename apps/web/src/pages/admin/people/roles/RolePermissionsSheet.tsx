import { useEffect, useMemo, useState } from 'react';
import {
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  LoadingState,
  QueryErrorBanner,
  SectionLabel,
  Sheet,
  useToast,
} from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts/schemas/roles';
import { trpc } from '../../../../lib/trpc';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useI18n, useRoleLabels } from '../../../../hooks/useI18n';
import { nativeConfirm } from '../../shared';
import { readRank, roleRankRange } from '../../../../lib/adminFields';
import { canPutKeyInRole, type PassOn } from '../../../../lib/authority';
import { groupPermissions } from '../permissionGroups';
import { PermissionKeyOption } from './PermissionKeyOption';
import { RankField } from './RankField';
import { RoleAssigneesByStore } from './RoleAssigneesByStore';

/** What the edit form holds of a role, to notice a save from elsewhere. */
interface RoleFields {
  name: string;
  description: string;
  rank: number;
  permissions: string[];
}

function fieldsOf(role: {
  name: string;
  description: string | null;
  rank: number;
  permissions: readonly string[];
}): RoleFields {
  return {
    name: role.name,
    description: role.description ?? '',
    rank: role.rank,
    permissions: [...role.permissions].sort(),
  };
}

function sameFields(a: RoleFields, b: RoleFields): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.rank === b.rank &&
    a.permissions.length === b.permissions.length &&
    a.permissions.every((key, i) => key === b.permissions[i])
  );
}

/** Sheet showing the explicit permission keys for one role. Read-only
 *  for now; the canEdit prop reserves space for the editable matrix. */
export function RolePermissionsSheet({
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
  const roleText = useRoleLabels();
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
  const [rankText, setRankText] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  // The saved role the form started from.
  const [base, setBase] = useState<RoleFields | null>(null);

  // Review ADM1-21 (2026-11-12): the form is filled from the role when
  // editing starts, and again only when the editor asks for the latest.
  // It was refilled, and edit mode left, whenever the role's data changed:
  // a grant or revoke of the role anywhere in the workspace refetches it
  // (people.changed), and what was being typed was silently put back.
  const startEditing = () => {
    const role = detail.data;
    if (!role) return;
    setName(role.name);
    setDescription(role.description ?? '');
    setRankText(String(role.rank));
    setPicked(new Set(role.permissions));
    setBase(fieldsOf(role));
    setEditing(true);
  };
  // Closed, or another role: back to the read view.
  useEffect(() => {
    setEditing(false);
  }, [open, roleSlug]);
  // Someone else saved this role while it was being edited here.
  const changedElsewhere =
    editing && !!base && !!detail.data && !sameFields(base, fieldsOf(detail.data));

  // Below-rank gate — only roles strictly below actor's rank are editable.
  const isEditable = canEdit && (detail.data?.rank ?? 100) < myMaxRank;
  const isBuiltIn = detail.data?.isBuiltIn ?? false;
  // ADM1-20: every binding counts, suspended holders and lapsed grants
  // too, as the server counts them (older servers: the listed holders).
  const held = (detail.data?.bindingCount ?? detail.data?.assignees.length ?? 0) > 0;
  // ADM1-02: a held role keeps its side of ADMIN_RANK.
  const rankRange = roleRankRange(detail.data?.rank ?? 0, held, myMaxRank, ADMIN_RANK);
  const rankRead = readRank(rankText, rankRange.max, rankRange.min);
  const rank = rankRead.ok ? rankRead.rank : (detail.data?.rank ?? 0);
  // DX-ADM-28: the edit form asks before its changes are thrown away.
  const editChanged =
    editing &&
    !!base &&
    (name !== base.name ||
      description !== base.description ||
      rankText !== String(base.rank) ||
      picked.size !== base.permissions.length ||
      base.permissions.some((k) => !picked.has(k)));

  const update = trpc.admin.roleUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      void utils.admin.roleDetail.invalidate({ roleSlug: roleSlug ?? '' });
      toast.success(i18n.t('admin.toast.roleUpdated'));
      setEditing(false);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const remove = trpc.admin.roleDelete.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      toast.success(i18n.t('admin.toast.roleDeleted'));
      onClose();
    },
    onError: errToast('common.errors.actionFailed'),
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
    const source: ReadonlyArray<{ key: string; description: string | null; passOn?: PassOn }> =
      editing
        ? (permsQuery.data ?? [])
        : (detail.data?.permissions ?? []).map((k) => ({ key: k, description: null }));
    return groupPermissions(source, (ns) => roleText.permissionGroup(ns), i18n.locale);
  }, [editing, detail.data, permsQuery.data, roleText, i18n.locale]);
  // ADM1-07: keys the role has may stay (roleUpdate gates only additions).
  const inRole = useMemo(() => new Set(detail.data?.permissions ?? []), [detail.data]);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      hasChanges={editChanged && !update.isPending}
      title={detail.data ? roleText.name(detail.data) : i18n.t('people.roleFallback')}
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
              disabled={!isBuiltIn && !rankRead.ok}
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
            <Button block onClick={startEditing}>
              {i18n.t('common.edit')}
            </Button>
            {!isBuiltIn ? (
              <>
                {/* ADM1-07: a held role cannot be deleted; say so up front. */}
                <Button
                  block
                  variant="danger"
                  loading={remove.isPending}
                  disabled={held}
                  onClick={() => {
                    nativeConfirm(
                      i18n.t('people.confirmDeleteRole', { name: roleText.name(detail.data!) }),
                      () => remove.mutate({ roleId: detail.data!.id }),
                    );
                  }}
                >
                  {i18n.t('people.deleteRole')}
                </Button>
                {held ? (
                  <p className="text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t('admin.errors.roleHasBindings')}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {detail.isLoading ? (
        <LoadingState />
      ) : detail.isError && !detail.data ? (
        // Review UI-13 (2026-11-11): a failed load read "no role".
        <QueryErrorBanner query={detail} />
      ) : !detail.data ? (
        <EmptyState compact title={i18n.t('people.noRole')} />
      ) : (
        <div className="flex flex-col gap-3 py-3">
          {editing ? (
            <>
              {changedElsewhere ? (
                <Banner
                  tone="warn"
                  title={i18n.t('people.roleChangedElsewhere')}
                  action={
                    <Button size="sm" variant="pearl" onClick={startEditing}>
                      {i18n.t('people.roleLoadLatest')}
                    </Button>
                  }
                >
                  {i18n.t('people.roleChangedElsewhereBody')}
                </Banner>
              ) : null}
              <Field label={i18n.t('admin.field.name')} required>
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
                <RankField
                  text={rankText}
                  onText={setRankText}
                  min={rankRange.min}
                  max={rankRange.max}
                  hint={
                    rankRange.locked
                      ? i18n.t('people.rankTierLocked', { rank: ADMIN_RANK })
                      : undefined
                  }
                />
              )}
              {/* M2.1: SectionLabel (was ad-hoc eyebrow div). */}
              <SectionLabel className="px-0">
                {i18n.t('people.permissionsHeading', { n: picked.size })}
              </SectionLabel>
            </>
          ) : roleText.description(detail.data) ? (
            <p className="text-old-body-sm text-[var(--c-fg-muted)]">
              {roleText.description(detail.data)}
            </p>
          ) : null}
          {editing && permsQuery.isLoading ? (
            <LoadingState variant="compact" />
          ) : editing && permsQuery.isError && !permsQuery.data ? (
            // Review ADM1-22 (2026-11-12): a failed load of the permission
            // list read "no permissions assigned".
            <QueryErrorBanner query={permsQuery} />
          ) : grouped.length === 0 ? (
            <p className="text-old-body text-[var(--c-fg-muted)]">
              {i18n.t('people.noPermsAssigned')}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {grouped.map(([ns, keys]) => (
                <li key={ns}>
                  <SectionLabel padded={false}>{roleText.permissionGroup(ns)}</SectionLabel>
                  <ul className="mt-1 flex flex-col gap-1">
                    {keys.map((p) => {
                      if (editing) {
                        const blocked = !inRole.has(p.key) && !canPutKeyInRole(p);
                        return (
                          <li key={p.key}>
                            <PermissionKeyOption
                              perm={p}
                              checked={picked.has(p.key)}
                              blocked={blocked ? i18n.t('people.perm.roleNeedsOwn') : null}
                              onToggle={() => togglePerm(p.key)}
                            />
                          </li>
                        );
                      }
                      return (
                        <li
                          key={p.key}
                          className="rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 py-1.5 text-old-label"
                        >
                          {/* ADM-17: what the permission allows, in the UI
                              language; the key stays as a hint. */}
                          {roleText.permission(p.key, p.description)}
                          <span className="ml-1.5 font-mono text-old-tiny text-[var(--c-fg-muted)]">
                            {p.key}
                          </span>
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
