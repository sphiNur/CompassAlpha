import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@compass/ui';
import { Button, cn, Field, Sheet, StatusChip } from '@compass/ui/kit';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useErrToast } from '../../lib/errToast';
import { confirmThen } from '../../lib/confirm';
import { useI18n, usePermissionLabel, useRoleLabel } from '../../hooks/useI18n';
import { ChevronIcon, PlusIcon } from '../icons';

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70 disabled:opacity-40';
const pick = (on: boolean) =>
  cn(CAPSULE, on ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink');
const ROW =
  'flex min-h-row w-full items-center gap-lg py-sm text-start outline-none active:opacity-60';

interface RoleRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  rank: number;
  isBuiltIn: boolean;
}

/** A code for the server, which wants one; nobody here has a use for it. */
function codeFor(name: string): string {
  const fromName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const unique = Date.now().toString(36);
  return fromName ? `${fromName}-${unique}` : `role-${unique}`;
}

function byGroup<T extends { key: string }>(items: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const ns = item.key.split('.')[0] ?? '';
    groups.set(ns, [...(groups.get(ns) ?? []), item]);
  }
  return [...groups.entries()];
}

/**
 * The roles of the organisation: what each allows and who holds it.
 *
 * Two things here were written for the people who build the product and
 * are said to an owner instead. A permission is a sentence ("Approve or
 * reject orders"), not its code. And where a role stands is said by the
 * role it ranks below, not by a number from 1 to 99: the number only
 * ever meant "who may give this role to whom".
 */
export function RolesScreen({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const i18n = useI18n();
  const roleLabel = useRoleLabel();
  const session = useAuthStore((s) => s.session);
  const myRank = session?.myMaxRank ?? 0;
  const roles = trpc.admin.roleList.useQuery();
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Making a role is for someone who administers every store.
  const administered = new Set(session?.adminStoreIds ?? []);
  const mine = session?.stores ?? [];
  const everywhere =
    mine.length === 0 ? administered.size > 0 : mine.every((s) => administered.has(s.id));

  const rows = useMemo(() => [...(roles.data ?? [])].sort((a, b) => b.rank - a.rank), [roles.data]);

  return (
    <div className="flex flex-col gap-xl px-page">
      <p className="text-body text-secondary">{i18n.t('roles.howBody')}</p>

      {everywhere ? (
        <button
          type="button"
          data-testid="role-new"
          onClick={() => setCreating(true)}
          className="flex items-center gap-lg rounded-lg border border-dashed border-line p-xl text-start outline-none active:opacity-60"
        >
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
          >
            <PlusIcon />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-label text-ink">{i18n.t('roles.new')}</span>
            <span className="block text-small text-secondary">{i18n.t('roles.newHint')}</span>
          </span>
          <span className="shrink-0 text-forest">
            <ChevronIcon />
          </span>
        </button>
      ) : null}

      {roles.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : roles.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => {
            const said = roleLabel(r);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid="role-row"
                  onClick={() => setOpenSlug(r.slug)}
                  className={ROW}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-label text-ink">{said.name}</span>
                    {said.description ? (
                      <span className="block text-small text-secondary">{said.description}</span>
                    ) : null}
                  </span>
                  {/* Only the exception is marked: a role this person
                      cannot hand out. */}
                  {r.rank >= myRank ? (
                    <StatusChip tone="neutral">{i18n.t('roles.youCannotGrant')}</StatusChip>
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

      <RoleSheet
        slug={openSlug}
        roles={rows}
        myRank={myRank}
        mayEdit={isSuperAdmin}
        onClose={() => setOpenSlug(null)}
      />
      <RoleEditor
        open={creating}
        role={null}
        roles={rows}
        myRank={myRank}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}

/** One role: what it allows, who holds it, and the way to change it. */
function RoleSheet({
  slug,
  roles,
  myRank,
  mayEdit,
  onClose,
}: {
  slug: string | null;
  roles: RoleRow[];
  myRank: number;
  mayEdit: boolean;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const roleLabel = useRoleLabel();
  const say = usePermissionLabel();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const detail = trpc.admin.roleDetail.useQuery({ roleSlug: slug ?? '' }, { enabled: !!slug });
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [slug]);

  const remove = trpc.admin.roleDelete.useMutation({
    onSuccess: () => {
      void utils.admin.roleList.invalidate();
      toast.success(i18n.t('admin.toast.roleDeleted'));
      onClose();
    },
    onError: errToast('common.error'),
  });

  const role = detail.data && detail.data.slug === slug ? detail.data : null;
  const said = role ? roleLabel(role) : null;
  // Changing a role is for the top of the organisation, and never a
  // role level with or above one's own.
  const editable = mayEdit && !!role && role.rank < myRank;
  const where = (a: NonNullable<typeof role>['assignees'][number]) =>
    a.scopeType === 'store' && a.scopeId
      ? (a.storeName ?? i18n.t('people.storeGone'))
      : i18n.t('people.everyStore');

  if (role && editing) {
    return (
      <RoleEditor
        open
        role={{ ...role, permissionKeys: role.permissions }}
        roles={roles}
        myRank={myRank}
        onClose={() => setEditing(false)}
      />
    );
  }

  return (
    <Sheet
      open={!!slug}
      onOpenChange={(next) => !next && !remove.isPending && onClose()}
      title={said?.name ?? ''}
      actions={
        editable ? (
          <>
            <Button variant="primary" data-testid="role-edit" onClick={() => setEditing(true)}>
              {i18n.t('common.edit')}
            </Button>
            {!role.isBuiltIn ? (
              <Button
                variant="ghost"
                data-testid="role-delete"
                disabled={remove.isPending}
                onClick={() =>
                  confirmThen(
                    i18n.t('people.confirmDeleteRole', { name: role.name }) as string,
                    () => remove.mutate({ roleId: role.id }),
                  )
                }
              >
                <span className="text-danger">{i18n.t('people.deleteRole')}</span>
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {!role || !said ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : (
        <div className="flex flex-col gap-xl">
          {said.description ? <p className="text-body text-secondary">{said.description}</p> : null}

          <section className="flex flex-col gap-md">
            <h3 className="text-label text-ink">{i18n.t('roles.can')}</h3>
            {role.permissions.length === 0 ? (
              <p className="text-body text-secondary">{i18n.t('people.noPermsAssigned')}</p>
            ) : (
              byGroup(role.permissions.map((key) => ({ key }))).map(([ns, items]) => (
                <div key={ns} className="flex flex-col gap-xs">
                  <span className="text-small text-secondary">{say.group(ns)}</span>
                  {items.map((p) => (
                    <span key={p.key} data-testid="role-permission" className="text-body text-ink">
                      {say.permission(p.key)}
                    </span>
                  ))}
                </div>
              ))
            )}
          </section>

          <section className="flex flex-col gap-sm">
            <h3 className="text-label text-ink">
              {i18n.t('roles.holders', { n: role.assignees.length })}
            </h3>
            {role.assignees.map((a) => (
              <div key={a.bindingId} className="flex min-h-row items-center gap-lg">
                <span
                  aria-hidden
                  className="flex size-avatar shrink-0 items-center justify-center overflow-hidden rounded-pill bg-surface text-label text-ink"
                >
                  {a.avatarUrl ? (
                    <img src={a.avatarUrl} alt="" className="size-full object-cover" />
                  ) : (
                    (Array.from(a.displayName.trim())[0] ?? '')
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-ink">{a.displayName}</span>
                  <span className="block text-small text-secondary">{where(a)}</span>
                </span>
              </div>
            ))}
          </section>
        </div>
      )}
    </Sheet>
  );
}

/** Making a role, or changing one. */
function RoleEditor({
  open,
  role,
  roles,
  myRank,
  onClose,
}: {
  open: boolean;
  role: (RoleRow & { permissionKeys: string[] }) | null;
  roles: RoleRow[];
  myRank: number;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const roleLabel = useRoleLabel();
  const say = usePermissionLabel();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const permissions = trpc.admin.permissionList.useQuery(undefined, { enabled: open });

  // The roles this one may rank below: those this person outranks,
  // highest first.
  const above = roles.filter((r) => r.rank < myRank && r.id !== role?.id && r.rank > 1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rank, setRank] = useState(1);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setDescription(role?.description ?? '');
    // A role an owner makes is nearly always for someone in a store, so
    // it starts under the store manager where there is one.
    const start = above.find((r) => r.slug === 'manager') ?? above[0];
    setRank(role?.rank ?? Math.max(1, (start?.rank ?? myRank) - 1));
    setPicked(new Set(role?.permissionKeys ?? []));
    // Only when the sheet opens or its role changes, not on every list refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role?.id]);

  const done = (message: string) => () => {
    void utils.admin.roleList.invalidate();
    void utils.admin.roleDetail.invalidate();
    toast.success(message);
    onClose();
  };
  const create = trpc.admin.roleCreate.useMutation({
    onSuccess: done(i18n.t('admin.toast.roleCreated') as string),
    onError: errToast('common.error'),
  });
  const update = trpc.admin.roleUpdate.useMutation({
    onSuccess: done(i18n.t('admin.toast.roleUpdated') as string),
    onError: errToast('common.error'),
  });
  const busy = create.isPending || update.isPending;

  const toggle = (key: string) =>
    setPicked((before) => {
      const next = new Set(before);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // "Below the manager" is one under the manager's rank. Which of them a
  // rank sits under: the lowest role still above it.
  const under = [...above].reverse().find((r) => r.rank > rank) ?? null;

  const save = () => {
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      permissionKeys: [...picked],
    };
    if (role) {
      // A built-in role keeps its place: the others are placed against it.
      update.mutate({ roleId: role.id, ...body, ...(role.isBuiltIn ? {} : { rank }) });
    } else {
      create.mutate({ slug: codeFor(name), ...body, rank });
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && !busy && onClose()}
      title={role ? roleLabel(role).name : (i18n.t('roles.new') as string)}
      actions={
        <Button
          variant="primary"
          data-testid="role-save"
          busy={busy}
          disabled={!name.trim() || rank < 1 || rank >= myRank}
          onClick={save}
        >
          {role ? i18n.t('common.save') : i18n.t('common.create')}
        </Button>
      }
    >
      <div className="flex flex-col gap-xl">
        <div className="flex flex-col gap-md">
          <Field
            label={i18n.t('admin.field.name') as string}
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            label={i18n.t('admin.field.description') as string}
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {role?.isBuiltIn ? null : (
          <div className="flex flex-col gap-sm">
            <span className="text-label text-ink">{i18n.t('roles.below')}</span>
            <div className="flex flex-wrap gap-sm">
              {above.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={under?.id === r.id}
                  data-testid="role-below"
                  onClick={() => setRank(r.rank - 1)}
                  className={pick(under?.id === r.id)}
                >
                  {roleLabel(r).name}
                </button>
              ))}
            </div>
            <p className="text-small text-secondary">{i18n.t('roles.belowHint')}</p>
          </div>
        )}

        <section className="flex flex-col gap-md">
          <h3 className="text-label text-ink">
            {i18n.t('roles.can')} · {picked.size}
          </h3>
          {permissions.isPending ? (
            <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
          ) : (
            byGroup(permissions.data ?? []).map(([ns, items]) => (
              <div key={ns} className="flex flex-col">
                <span className="text-small text-secondary">{say.group(ns)}</span>
                {items.map((p) => {
                  const on = picked.has(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      data-testid="role-toggle"
                      onClick={() => toggle(p.key)}
                      className={ROW}
                    >
                      <span className="min-w-0 flex-1 text-body text-ink">
                        {say.permission(p.key, p.description)}
                      </span>
                      <span
                        aria-hidden
                        className={cn(
                          'flex size-disc shrink-0 items-center justify-center rounded-pill text-caption',
                          on ? 'bg-primary text-on-primary' : 'border border-line text-transparent',
                        )}
                      >
                        ✓
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </section>
      </div>
    </Sheet>
  );
}
