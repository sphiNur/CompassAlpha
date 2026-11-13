import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Field,
  Input,
  LoadingState,
  QueryErrorBanner,
  SectionLabel,
  Sheet,
  useToast,
} from '@compass/ui';
import { ADMIN_RANK } from '@compass/contracts/schemas/roles';
import { SLUG_MESSAGE } from '@compass/contracts/limits';
import { trpc } from '../../../../lib/trpc';
import { useErrToast } from '../../../../hooks/useErrToast';
import { useI18n, useRoleLabels } from '../../../../hooks/useI18n';
import {
  codeFromName,
  defaultNewRoleRank,
  normaliseSlugInput,
  readRank,
  slugIsValid,
} from '../../../../lib/adminFields';
import { canPutKeyInRole } from '../../../../lib/authority';
import { groupPermissions } from '../permissionGroups';
import { PermissionGroupList } from '../PermissionGroupList';
import { PermissionKeyOption } from './PermissionKeyOption';
import { RankField } from './RankField';

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
export function RoleCreateSheet({
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
  const roleText = useRoleLabels();
  const permsQuery = trpc.admin.permissionList.useQuery(undefined, { enabled: open });
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // DX-ADM-4: one tier below the actor, never at or above admin. The
  // rank is kept as typed and read on blur / save (lib/adminFields).
  const defaultRank = defaultNewRoleRank(myMaxRank, ADMIN_RANK);
  const maxRank = myMaxRank - 1;
  const [rankText, setRankText] = useState(String(defaultRank));
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  // Reset when sheet re-opens for a fresh create.
  useEffect(() => {
    if (open) {
      setSlug('');
      setName('');
      setDescription('');
      setRankText(String(defaultNewRoleRank(myMaxRank, ADMIN_RANK)));
      setPicked(new Set());
    }
  }, [open, myMaxRank]);
  const rankRead = readRank(rankText, maxRank);
  const slugBad = slug.length > 0 && !slugIsValid(slug);
  // D2 (2026-11-13): an empty short code is made from the name, unique in
  // the workspace; the field shows it as its placeholder.
  const rolesQuery = trpc.admin.roleList.useQuery(undefined, { enabled: open });
  const autoSlug = useMemo(
    () => codeFromName([name], new Set((rolesQuery.data ?? []).map((r) => r.slug)), 'role'),
    [name, rolesQuery.data],
  );
  const slugToSend = slug.trim().replace(/^-+|-+$/g, '') || autoSlug;
  // DX-IX-10: ask before Esc / backdrop / Back throws the typing away.
  const createChanged =
    slug !== '' ||
    name !== '' ||
    description !== '' ||
    rankText !== String(defaultRank) ||
    picked.size > 0;

  const grouped = useMemo(
    () =>
      groupPermissions(permsQuery.data ?? [], (ns) => roleText.permissionGroup(ns), i18n.locale),
    [permsQuery.data, roleText, i18n.locale],
  );

  const create = trpc.admin.roleCreate.useMutation({
    onSuccess: (data) => {
      // ADM-10 (2026-10-30): an existing slug returns that role
      // (idempotent replay) — it used to read "role created" and drop
      // everything typed here.
      if (!data.created) {
        toast.error(i18n.t('admin.errors.roleSlugTaken'));
        return;
      }
      void utils.admin.roleList.invalidate();
      toast.success(i18n.t('admin.toast.roleCreated'));
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

  const canSave = slugIsValid(slugToSend) && name.trim().length > 0 && rankRead.ok;
  // UX-05: what the disabled Create is waiting for, first problem first.
  const saveHint = !name.trim()
    ? i18n.t('common.hint.fillIn', { field: i18n.t('admin.field.name') })
    : slugBad
      ? i18n.t(SLUG_MESSAGE.role)
      : !slugIsValid(slugToSend)
        ? i18n.t('common.hint.fillIn', { field: i18n.t('admin.field.slug') })
        : !rankRead.ok
          ? i18n.t('people.rankInvalid', { min: 1, max: maxRank })
          : '';

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      hasChanges={createChanged && !create.isPending}
      title={i18n.t('people.newRoleTitle')}
      description={i18n.t('people.newRoleHint', { max: myMaxRank - 1 })}
      footer={
        <Button
          block
          loading={create.isPending}
          disabled={!canSave}
          disabledHint={saveHint}
          onClick={() => {
            if (!rankRead.ok) return;
            create.mutate({
              slug: slugToSend,
              name: name.trim(),
              description: description.trim() || null,
              rank: rankRead.rank,
              permissionKeys: [...picked],
            });
          }}
        >
          {i18n.t('common.create')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 py-3">
        <Field label={i18n.t('admin.field.name')} required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            placeholder={i18n.t('people.rolePlaceholderName')}
            autoFocus
          />
        </Field>
        {/* DX-ADM-4: say the rule instead of greying the button out. D2: below
            the name, which fills it when it is left empty. */}
        <Field
          label={i18n.t('admin.field.slug')}
          hint={slugBad ? null : i18n.t('people.slugRule')}
          error={slugBad ? i18n.t(SLUG_MESSAGE.role) : null}
        >
          <Input
            value={slug}
            onChange={(e) => setSlug(normaliseSlugInput(e.target.value))}
            maxLength={64}
            placeholder={autoSlug}
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
        <RankField text={rankText} onText={setRankText} max={maxRank} />
        <div>
          {/* M2.1: SectionLabel (was ad-hoc eyebrow). */}
          <SectionLabel className="mb-2 px-0">
            {i18n.t('people.permissionsHeading', { n: picked.size })}
          </SectionLabel>
          {permsQuery.isLoading ? (
            <LoadingState variant="compact" />
          ) : permsQuery.isError && !permsQuery.data ? (
            // Review ADM1-22 (2026-11-12): a failed load showed no
            // permissions at all.
            <QueryErrorBanner query={permsQuery} />
          ) : (
            <PermissionGroupList
              groups={grouped}
              renderRow={(p) => (
                <PermissionKeyOption
                  perm={p}
                  checked={picked.has(p.key)}
                  blocked={canPutKeyInRole(p) ? null : i18n.t('people.perm.roleNeedsOwn')}
                  onToggle={() => togglePerm(p.key)}
                />
              )}
            />
          )}
        </div>
      </div>
    </Sheet>
  );
}
