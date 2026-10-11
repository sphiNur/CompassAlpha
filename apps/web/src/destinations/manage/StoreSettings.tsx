import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@compass/ui';
import { Button, cn, Field, Sheet } from '@compass/ui/kit';
import { ADMIN_RANK } from '@compass/contracts';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import { useNavStore } from '../../stores/navStore';
import { useErrToast } from '../../lib/errToast';
import { confirmThen } from '../../lib/confirm';
import { useI18n, useRoleLabel } from '../../hooks/useI18n';

interface Draft {
  name: string;
  address: string;
  code: string;
  timezone: string;
  isActive: boolean;
  defaultRoleSlug: string;
}

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70 disabled:opacity-40';
const pick = (on: boolean) =>
  cn(CAPSULE, on ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink');
const QUIET =
  'flex h-control w-full items-center justify-center rounded-pill bg-surface-sunken px-lg text-label text-ink outline-none active:opacity-70 disabled:opacity-50';

/**
 * One store's own settings: what it is called and where it is, the role
 * a newcomer gets, and whether it is open. Someone who does not
 * administer the store sees them and cannot change them.
 *
 * Save lights up only when something differs from what is stored.
 */
export function StoreSettings({ storeId }: { storeId: string }) {
  const i18n = useI18n();
  const roleLabel = useRoleLabel();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const session = useAuthStore((s) => s.session);
  const leave = useNavStore((s) => s.setStoreFocus);

  const stores = trpc.admin.storeList.useQuery();
  const roles = trpc.admin.roleList.useQuery();
  const store = stores.data?.find((s) => s.id === storeId) ?? null;

  const administered = useMemo(
    () => new Set(session?.adminStoreIds ?? []),
    [session?.adminStoreIds],
  );
  const mine = session?.stores ?? [];
  const everywhere =
    mine.length === 0 ? administered.size > 0 : mine.every((s) => administered.has(s.id));
  const may = administered.has(storeId);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [more, setMore] = useState(false);
  const [cloning, setCloning] = useState(false);
  useEffect(() => {
    if (!store) return;
    setDraft({
      name: store.name,
      address: store.address ?? '',
      code: store.code ?? '',
      timezone: store.timezone ?? '',
      isActive: store.isActive,
      defaultRoleSlug: store.defaultRoleSlug ?? '',
    });
  }, [store]);

  const update = trpc.admin.storeUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      void utils.catalog.stores.invalidate();
      // The session carries the list of stores; keep it current.
      void utils.auth.me.invalidate();
      toast.success(i18n.t('admin.toast.storeUpdated'));
    },
    onError: errToast('common.error'),
  });
  const archive = trpc.admin.storeDelete.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      void utils.catalog.stores.invalidate();
      // The session carries the list of stores; keep it current.
      void utils.auth.me.invalidate();
      toast.success(i18n.t('admin.toast.storeArchived'));
      // The store is gone from the list: back to the list.
      leave(null);
    },
    onError: errToast('common.error'),
  });

  // The roles someone can hold at a store, highest first.
  const storeRoles = [...(roles.data ?? [])]
    .filter((r) => r.rank < ADMIN_RANK)
    .sort((a, b) => b.rank - a.rank);

  if (stores.isPending || !draft || !store) {
    return <p className="px-page text-body text-secondary">{i18n.t('common.loading')}</p>;
  }

  const dirty =
    draft.name !== store.name ||
    draft.address !== (store.address ?? '') ||
    draft.code !== (store.code ?? '') ||
    draft.timezone !== (store.timezone ?? '') ||
    draft.isActive !== store.isActive ||
    draft.defaultRoleSlug !== (store.defaultRoleSlug ?? '');

  return (
    <div className="flex flex-col gap-xl px-page pt-sm">
      {!may ? (
        <p role="status" className="rounded-lg bg-warning-pale p-xl text-body text-warning-ink">
          {i18n.t('admin.store.readOnlyBody')}
        </p>
      ) : null}

      <div className="flex flex-col gap-md">
        <Field
          label={i18n.t('admin.field.name') as string}
          value={draft.name}
          maxLength={200}
          disabled={!may}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <Field
          label={i18n.t('admin.field.address') as string}
          value={draft.address}
          maxLength={500}
          disabled={!may}
          onChange={(e) => setDraft({ ...draft, address: e.target.value })}
        />
        {more || draft.code || draft.timezone ? (
          <>
            <Field
              label={i18n.t('admin.field.code') as string}
              value={draft.code}
              maxLength={32}
              disabled={!may}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
            <Field
              label={i18n.t('admin.field.timezone') as string}
              value={draft.timezone}
              maxLength={64}
              disabled={!may}
              placeholder={i18n.t('admin.field.timezonePlaceholder') as string}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
            />
          </>
        ) : (
          <button
            type="button"
            onClick={() => setMore(true)}
            className={cn(CAPSULE, 'self-start bg-surface-sunken text-ink')}
          >
            {i18n.t('stores.more')}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-sm">
        <span className="text-label text-ink">{i18n.t('admin.field.defaultRole')}</span>
        <div className="flex flex-wrap gap-sm">
          {[{ slug: '', name: i18n.t('stores.noDefaultRole') as string }, ...storeRoles].map(
            (r) => (
              <button
                key={r.slug || 'none'}
                type="button"
                aria-pressed={draft.defaultRoleSlug === r.slug}
                data-testid="store-default-role"
                disabled={!may}
                onClick={() => setDraft({ ...draft, defaultRoleSlug: r.slug })}
                className={pick(draft.defaultRoleSlug === r.slug)}
              >
                {r.slug ? roleLabel(r).name : r.name}
              </button>
            ),
          )}
        </div>
        <p className="text-small text-secondary">{i18n.t('admin.store.defaultRoleHint')}</p>
      </div>

      <div className="flex flex-col gap-sm">
        <span className="text-label text-ink">{i18n.t('stores.status')}</span>
        <div className="flex flex-wrap gap-sm">
          {[true, false].map((on) => (
            <button
              key={String(on)}
              type="button"
              aria-pressed={draft.isActive === on}
              data-testid="store-status"
              disabled={!may}
              onClick={() => setDraft({ ...draft, isActive: on })}
              className={pick(draft.isActive === on)}
            >
              {on ? i18n.t('stores.open') : i18n.t('stores.paused')}
            </button>
          ))}
        </div>
        <p className="text-small text-secondary">{i18n.t('stores.pausedHint')}</p>
      </div>

      {may ? (
        <div className="flex flex-col gap-sm">
          <Button
            variant="primary"
            data-testid="store-settings-save"
            busy={update.isPending}
            disabled={!dirty || !draft.name.trim()}
            onClick={() =>
              update.mutate({
                storeId,
                name: draft.name.trim(),
                code: draft.code.trim() || null,
                address: draft.address.trim() || null,
                timezone: draft.timezone.trim() || null,
                isActive: draft.isActive,
                defaultRoleSlug: draft.defaultRoleSlug || null,
              })
            }
          >
            {i18n.t('common.save')}
          </Button>
          {/* Across the whole organisation, so only for someone who
              administers all of it, and only when there is another store
              to copy from. */}
          {everywhere && administered.size >= 2 ? (
            <button
              type="button"
              data-testid="store-clone"
              className={QUIET}
              onClick={() => setCloning(true)}
            >
              {i18n.t('admin.action.cloneRoles')}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="store-archive"
            className={QUIET}
            disabled={archive.isPending}
            onClick={() =>
              confirmThen(
                i18n.t('admin.store.confirmArchive', { name: store.name }) as string,
                () => archive.mutate({ storeId }),
              )
            }
          >
            <span className="text-danger">{i18n.t('common.archive')}</span>
          </button>
        </div>
      ) : null}

      <CloneRoles
        open={cloning}
        storeId={storeId}
        storeName={store.name}
        onClose={() => setCloning(false)}
      />
    </div>
  );
}

/**
 * Give this store the same people in the same roles as another one:
 * what an owner wants when a second branch opens with the first one's
 * arrangement.
 */
function CloneRoles({
  open,
  storeId,
  storeName,
  onClose,
}: {
  open: boolean;
  storeId: string;
  storeName: string;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const session = useAuthStore((s) => s.session);
  const [source, setSource] = useState('');
  const [peopleToo, setPeopleToo] = useState(false);
  useEffect(() => {
    if (open) {
      setSource('');
      setPeopleToo(false);
    }
  }, [open]);

  const administered = new Set(session?.adminStoreIds ?? []);
  const sources = (session?.stores ?? []).filter(
    (st) => administered.has(st.id) && st.id !== storeId,
  );

  const clone = trpc.admin.storeCloneRoles.useMutation({
    onSuccess: (data) => {
      void utils.admin.storeList.invalidate();
      void utils.admin.memberList.invalidate();
      const parts = [i18n.t('admin.clone.toastCloned', { n: data.cloned })];
      if (data.skippedExisting > 0) {
        parts.push(i18n.t('admin.clone.toastAlreadyExisted', { n: data.skippedExisting }));
      }
      if (data.skippedRank > 0) {
        parts.push(i18n.t('admin.clone.toastSkippedRank', { n: data.skippedRank }));
      }
      if (data.assigned > 0) parts.push(i18n.t('admin.clone.toastAssigned', { n: data.assigned }));
      toast.success(parts.join(' · '));
      onClose();
    },
    onError: errToast('common.error'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && !clone.isPending && onClose()}
      title={i18n.t('admin.clone.title') as string}
      actions={
        <Button
          variant="primary"
          data-testid="store-clone-go"
          busy={clone.isPending}
          disabled={!source}
          onClick={() =>
            clone.mutate({
              sourceStoreId: source,
              targetStoreId: storeId,
              includeMembers: peopleToo,
            })
          }
        >
          {i18n.t('admin.clone.action')}
        </Button>
      }
    >
      <div className="flex flex-col gap-xl">
        <p className="text-body text-secondary">
          {i18n.t('admin.clone.whatBody', { store: storeName })}
        </p>
        <div className="flex flex-col gap-sm">
          <span className="text-label text-ink">{i18n.t('admin.field.sourceStore')}</span>
          {sources.length === 0 ? (
            <div role="status" className="rounded-lg bg-warning-pale p-xl">
              <p className="text-label text-warning-ink">{i18n.t('admin.clone.noSourceTitle')}</p>
              <p className="text-small text-warning-ink">{i18n.t('admin.clone.noSourceBody')}</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-sm">
              {sources.map((st) => (
                <button
                  key={st.id}
                  type="button"
                  aria-pressed={source === st.id}
                  data-testid="store-clone-source"
                  onClick={() => setSource(st.id)}
                  className={pick(source === st.id)}
                >
                  {st.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-sm">
          <button
            type="button"
            aria-pressed={peopleToo}
            data-testid="store-clone-people"
            onClick={() => setPeopleToo(!peopleToo)}
            className={cn(pick(peopleToo), 'self-start')}
          >
            {i18n.t('admin.clone.alsoMembers')}
          </button>
          <p className="text-small text-secondary">{i18n.t('admin.clone.alsoMembersHint')}</p>
        </div>
      </div>
    </Sheet>
  );
}
