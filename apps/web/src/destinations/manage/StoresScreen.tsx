import { useMemo, useState } from 'react';
import { useToast } from '@compass/ui';
import { Button, cn, Field, Sheet, StatusChip } from '@compass/ui/kit';
import { trpc } from '../../lib/trpc';
import { useErrToast } from '../../lib/errToast';
import { useI18n } from '../../hooks/useI18n';
import type { StoreFocus } from '../../pages/admin/shared';
import { ChevronIcon, ManageIcon, PlusIcon } from '../icons';

interface Draft {
  name: string;
  address: string;
  code: string;
  timezone: string;
}

/**
 * The organisation's stores, and the way into each one's people and
 * settings. Laid out like the other lists: what can be added is the
 * dashed card at the top; under it a row per store with a disc holding
 * its first letter, as wherever a store is shown.
 *
 * People who belong to no store (owners, administrators) are the first
 * row, when there are any.
 */
export function StoresScreen({ onPick }: { onPick: (focus: NonNullable<StoreFocus>) => void }) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const stores = trpc.admin.storeList.useQuery();
  const members = trpc.admin.memberList.useQuery();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [more, setMore] = useState(false);

  const create = trpc.admin.storeCreate.useMutation({
    onSuccess: () => {
      void utils.admin.storeList.invalidate();
      void utils.catalog.stores.invalidate();
      toast.success(i18n.t('admin.toast.storeCreated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });

  // Counted from the member list the other screens already keep.
  const counts = useMemo(() => {
    const byStore = new Map<string, number>();
    let noStore = 0;
    for (const m of members.data ?? []) {
      if (m.stores.length === 0) noStore++;
      for (const st of m.stores) byStore.set(st.id, (byStore.get(st.id) ?? 0) + 1);
    }
    return { byStore, noStore };
  }, [members.data]);

  const row =
    'flex min-h-row w-full items-center gap-lg py-sm text-start outline-none active:opacity-60';
  const disc =
    'flex size-avatar shrink-0 items-center justify-center rounded-pill bg-surface text-label text-ink';

  return (
    <div className="flex flex-col gap-xl px-page">
      <button
        type="button"
        data-testid="store-new"
        onClick={() => {
          setMore(false);
          setDraft({ name: '', address: '', code: '', timezone: '' });
        }}
        className="flex items-center gap-lg rounded-lg border border-dashed border-line p-xl text-start outline-none active:opacity-60"
      >
        <span
          aria-hidden
          className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
        >
          <PlusIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-label text-ink">{i18n.t('admin.store.new')}</span>
          <span className="block text-small text-secondary">
            {i18n.t('admin.store.createHint')}
          </span>
        </span>
        <span className="shrink-0 text-forest">
          <ChevronIcon />
        </span>
      </button>

      {stores.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : stores.isError ? (
        <div className="flex flex-col items-start gap-md">
          <p className="text-body text-danger">{i18n.t('common.error')}</p>
          <Button inline onClick={() => void stores.refetch()}>
            {i18n.t('common.retry')}
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col">
          {counts.noStore > 0 ? (
            <li>
              <button
                type="button"
                data-testid="store-row-org"
                onClick={() => onPick({ kind: 'org-level' })}
                className={row}
              >
                <span aria-hidden className={disc}>
                  <ManageIcon />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-ink">
                    {i18n.t('admin.label.orgLevel')}
                  </span>
                  <span className="block text-small text-secondary">
                    {[
                      i18n.t('admin.label.memberCount', { n: counts.noStore }),
                      i18n.t('admin.label.orgLevelHint'),
                    ].join(' · ')}
                  </span>
                </span>
                <span className="shrink-0 text-forest">
                  <ChevronIcon />
                </span>
              </button>
            </li>
          ) : null}
          {stores.data.map((st) => (
            <li key={st.id}>
              <button
                type="button"
                data-testid="store-row"
                onClick={() => onPick({ kind: 'store', storeId: st.id, storeName: st.name })}
                className={row}
              >
                <span aria-hidden className={disc}>
                  {Array.from(st.name.trim())[0] ?? ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-label text-ink">{st.name}</span>
                  <span className="block text-small text-secondary">
                    {[
                      i18n.t('admin.label.memberCount', {
                        n: counts.byStore.get(st.id) ?? 0,
                      }),
                      st.address?.trim() || null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {/* Open is the silent default; only a paused store says so. */}
                {!st.isActive ? (
                  <StatusChip tone="neutral">{i18n.t('stores.paused')}</StatusChip>
                ) : null}
                <span className="shrink-0 text-forest">
                  <ChevronIcon />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Sheet
        open={!!draft}
        onOpenChange={(next) => !next && !create.isPending && setDraft(null)}
        title={i18n.t('admin.store.new') as string}
        actions={
          <Button
            variant="primary"
            data-testid="store-save"
            busy={create.isPending}
            disabled={!draft?.name.trim()}
            onClick={() => {
              if (!draft) return;
              create.mutate({
                name: draft.name.trim(),
                code: draft.code.trim() || null,
                address: draft.address.trim() || null,
                timezone: draft.timezone.trim() || null,
              });
            }}
          >
            {i18n.t('common.create')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-md">
            <Field
              label={i18n.t('admin.field.name') as string}
              value={draft.name}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <Field
              label={i18n.t('admin.field.address') as string}
              value={draft.address}
              maxLength={500}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
            {more ? (
              <>
                <Field
                  label={i18n.t('admin.field.code') as string}
                  value={draft.code}
                  maxLength={32}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                />
                <Field
                  label={i18n.t('admin.field.timezone') as string}
                  value={draft.timezone}
                  maxLength={64}
                  placeholder="Asia/Tashkent"
                  onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                />
              </>
            ) : (
              <button
                type="button"
                onClick={() => setMore(true)}
                className={cn(
                  'flex h-pillbtn items-center self-start rounded-pill bg-surface-sunken px-lg text-label text-ink outline-none active:opacity-70',
                )}
              >
                {i18n.t('stores.more')}
              </button>
            )}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
