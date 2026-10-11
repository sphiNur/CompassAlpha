import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '@compass/ui';
import { Button, cn, Field, Sheet } from '@compass/ui/kit';
import { trpc } from '../../lib/trpc';
import { useErrToast } from '../../lib/errToast';
import { confirmThen } from '../../lib/confirm';
import { useI18n, useProductName } from '../../hooks/useI18n';
import { ChevronIcon, ClockIcon, PlusIcon } from '../icons';

const LANGS = [
  { key: 'uz', label: "O'zbekcha", example: 'Sabzavotlar' },
  { key: 'ru', label: 'Русский', example: 'Овощи' },
  { key: 'en', label: 'English', example: 'Vegetables' },
  { key: 'zh', label: '中文', example: '蔬菜' },
] as const;
type Lang = (typeof LANGS)[number]['key'];

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70';
const ROW =
  'flex min-h-row w-full items-center gap-lg py-sm text-start outline-none active:opacity-60';

/** What can be added, as the dashed card at the top of a list. */
function AddCard({
  title,
  hint,
  onPress,
  ...rest
}: {
  title: string;
  hint: string;
  onPress: () => void;
  'data-testid'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex items-center gap-lg rounded-lg border border-dashed border-line p-xl text-start outline-none active:opacity-60"
      {...rest}
    >
      <span
        aria-hidden
        className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
      >
        <PlusIcon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-label text-ink">{title}</span>
        <span className="block text-small text-secondary">{hint}</span>
      </span>
      <span className="shrink-0 text-forest">
        <ChevronIcon />
      </span>
    </button>
  );
}

function Nothing({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-lg">
      <span
        aria-hidden
        className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
      >
        <ClockIcon />
      </span>
      <span className="text-label text-secondary">{children}</span>
    </div>
  );
}

interface CategoryDraft {
  categoryId?: string;
  slug: string;
  names: Record<Lang, string>;
  sortIndex: number;
}

/**
 * The server wants a short code of lowercase letters, digits and dashes
 * for every category. Nobody using this screen has a use for it, so it
 * is made from the name; a name with no such letters in it (Chinese,
 * Cyrillic) gets a code that is merely unique.
 */
function codeFor(name: string): string {
  const fromName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const unique = Date.now().toString(36);
  return fromName ? `${fromName}-${unique}` : `c-${unique}`;
}

/**
 * The groups products are ordered under. A row says how many products a
 * category holds and opens it; one name is enough, as for a product.
 */
export function CategoriesScreen() {
  const i18n = useI18n();
  const productName = useProductName();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const categories = trpc.admin.categoryList.useQuery();
  const skus = trpc.admin.skuList.useQuery({ includeArchived: false });
  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [more, setMore] = useState(false);

  const done = (message: string) => () => {
    void utils.admin.categoryList.invalidate();
    void utils.catalog.categories.invalidate();
    toast.success(message);
    setDraft(null);
  };
  const create = trpc.admin.categoryCreate.useMutation({
    onSuccess: done(i18n.t('admin.toast.categoryCreated') as string),
    onError: errToast('common.error'),
  });
  const update = trpc.admin.categoryUpdate.useMutation({
    onSuccess: done(i18n.t('admin.toast.categoryUpdated') as string),
    onError: errToast('common.error'),
  });
  const archive = trpc.admin.categoryDelete.useMutation({
    onSuccess: done(i18n.t('admin.toast.categoryArchived') as string),
    onError: errToast('common.error'),
  });

  const held = useMemo(() => {
    const count = new Map<string, number>();
    for (const sku of skus.data ?? []) {
      if (sku.categoryId) count.set(sku.categoryId, (count.get(sku.categoryId) ?? 0) + 1);
    }
    return count;
  }, [skus.data]);

  const open = (next: CategoryDraft) => {
    setMore(false);
    setDraft(next);
  };
  const filled = draft ? LANGS.map((l) => draft.names[l.key].trim()).filter(Boolean) : [];
  const busy = create.isPending || update.isPending || archive.isPending;
  const save = () => {
    if (!draft || filled.length === 0) return;
    const fallback = draft.names[i18n.locale as Lang]?.trim() || filled[0]!;
    const names = Object.fromEntries(
      LANGS.map((l) => [l.key, draft.names[l.key].trim() || fallback]),
    ) as Record<Lang, string>;
    if (draft.categoryId) {
      update.mutate({
        categoryId: draft.categoryId,
        slug: draft.slug,
        names,
        sortIndex: draft.sortIndex,
      });
    } else {
      create.mutate({
        slug: codeFor(names.en || fallback),
        names,
        sortIndex: draft.sortIndex,
      });
    }
  };

  return (
    <div className="flex flex-col gap-xl px-page">
      <AddCard
        data-testid="category-new"
        title={i18n.t('catalog.category.new') as string}
        hint={i18n.t('catalog.category.emptyBody') as string}
        onPress={() =>
          open({ slug: '', names: { uz: '', ru: '', en: '', zh: '' }, sortIndex: 100 })
        }
      />

      {categories.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : categories.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : categories.data.length === 0 ? (
        <Nothing>{i18n.t('catalog.category.emptyTitle')}</Nothing>
      ) : (
        <ul className="flex flex-col">
          {categories.data.map((c) => {
            const names = c.names as Record<string, string>;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  data-testid="category-row"
                  onClick={() =>
                    open({
                      categoryId: c.id,
                      slug: c.slug,
                      names: {
                        uz: names.uz ?? '',
                        ru: names.ru ?? '',
                        en: names.en ?? '',
                        zh: names.zh ?? '',
                      },
                      sortIndex: c.sortIndex,
                    })
                  }
                  className={ROW}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block text-label',
                        c.isArchived ? 'text-secondary line-through' : 'text-ink',
                      )}
                    >
                      {productName({ names }) || c.slug}
                    </span>
                    <span className="block text-small text-secondary">
                      {[
                        i18n.t('run.label.itemsCount', { n: held.get(c.id) ?? 0 }),
                        c.isArchived ? i18n.t('products.archived') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="shrink-0 text-forest">
                    <ChevronIcon />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet
        open={!!draft}
        onOpenChange={(next) => !next && !busy && setDraft(null)}
        title={
          i18n.t(draft?.categoryId ? 'catalog.category.edit' : 'catalog.category.new') as string
        }
        actions={
          draft ? (
            <>
              <Button
                variant="primary"
                data-testid="category-save"
                busy={create.isPending || update.isPending}
                disabled={filled.length === 0 || archive.isPending}
                onClick={save}
              >
                {draft.categoryId ? i18n.t('common.save') : i18n.t('common.create')}
              </Button>
              {draft.categoryId ? (
                <Button
                  variant="ghost"
                  data-testid="category-archive"
                  disabled={busy}
                  onClick={() =>
                    confirmThen(
                      i18n.t('catalog.category.confirmArchive', {
                        name: filled[0] ?? '',
                      }) as string,
                      () => archive.mutate({ categoryId: draft.categoryId! }),
                    )
                  }
                >
                  <span className="text-danger">{i18n.t('common.archive')}</span>
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {draft ? (
          <div className="flex flex-col gap-xl">
            <div className="flex flex-col gap-md">
              {LANGS.map((l) => (
                <Field
                  key={l.key}
                  label={i18n.t('admin.field.nameInLocale', { locale: l.label }) as string}
                  value={draft.names[l.key]}
                  maxLength={200}
                  placeholder={l.example}
                  onChange={(e) =>
                    setDraft({ ...draft, names: { ...draft.names, [l.key]: e.target.value } })
                  }
                />
              ))}
              <p className="text-small text-secondary">{i18n.t('products.nameHint')}</p>
            </div>
            {more ? (
              <Field
                numeric
                label={i18n.t('admin.field.sortIndex') as string}
                value={String(draft.sortIndex)}
                onChange={(e) => setDraft({ ...draft, sortIndex: Number(e.target.value) || 0 })}
              />
            ) : (
              <button
                type="button"
                onClick={() => setMore(true)}
                className={cn(CAPSULE, 'self-start bg-surface-sunken text-ink')}
              >
                {i18n.t('admin.field.sortIndex')}
              </button>
            )}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

interface SupplierDraft {
  supplierId?: string;
  archived: boolean;
  name: string;
  contactPhone: string;
  contactTg: string;
  address: string;
  notes: string;
}

/**
 * Who things are bought from. A row has the name and how to reach them;
 * a name is all a new one needs.
 */
export function SuppliersScreen() {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const [archivedToo, setArchivedToo] = useState(false);
  const suppliers = trpc.admin.supplierList.useQuery({ includeArchived: archivedToo });
  const [draft, setDraft] = useState<SupplierDraft | null>(null);

  const done = (message: string) => () => {
    void utils.admin.supplierList.invalidate();
    toast.success(message);
    setDraft(null);
  };
  const create = trpc.admin.supplierCreate.useMutation({
    onSuccess: done(i18n.t('admin.toast.supplierCreated') as string),
    onError: errToast('common.error'),
  });
  const update = trpc.admin.supplierUpdate.useMutation({
    onSuccess: done(i18n.t('admin.toast.supplierUpdated') as string),
    onError: errToast('common.error'),
  });
  const archive = trpc.admin.supplierDelete.useMutation({
    onSuccess: done(i18n.t('admin.toast.supplierArchived') as string),
    onError: errToast('common.error'),
  });
  const busy = create.isPending || update.isPending || archive.isPending;

  const save = () => {
    if (!draft || !draft.name.trim()) return;
    const body = {
      name: draft.name.trim(),
      contactPhone: draft.contactPhone.trim() || null,
      contactTg: draft.contactTg.trim() || null,
      address: draft.address.trim() || null,
      notes: draft.notes.trim() || null,
    };
    if (draft.supplierId) {
      update.mutate({ supplierId: draft.supplierId, ...body, isArchived: draft.archived });
    } else {
      create.mutate(body);
    }
  };

  return (
    <div className="flex flex-col gap-xl px-page">
      <AddCard
        data-testid="supplier-new"
        title={i18n.t('catalog.supplier.new') as string}
        hint={i18n.t('catalog.supplier.emptyBody') as string}
        onPress={() =>
          setDraft({
            archived: false,
            name: '',
            contactPhone: '',
            contactTg: '',
            address: '',
            notes: '',
          })
        }
      />

      <button
        type="button"
        aria-pressed={archivedToo}
        data-testid="supplier-archived"
        onClick={() => setArchivedToo(!archivedToo)}
        className={cn(
          CAPSULE,
          'self-start',
          archivedToo ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink',
        )}
      >
        {i18n.t('admin.label.showArchived')}
      </button>

      {suppliers.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : suppliers.isError ? (
        <p className="text-body text-danger">{i18n.t('common.error')}</p>
      ) : suppliers.data.length === 0 ? (
        <Nothing>{i18n.t('catalog.supplier.emptyTitle')}</Nothing>
      ) : (
        <ul className="flex flex-col">
          {suppliers.data.map((sp) => (
            <li key={sp.id}>
              <button
                type="button"
                data-testid="supplier-row"
                onClick={() =>
                  setDraft({
                    supplierId: sp.id,
                    archived: sp.isArchived,
                    name: sp.name,
                    contactPhone: sp.contactPhone ?? '',
                    contactTg: sp.contactTg ?? '',
                    address: sp.address ?? '',
                    notes: sp.notes ?? '',
                  })
                }
                className={ROW}
              >
                <span
                  aria-hidden
                  className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-surface text-label text-ink"
                >
                  {Array.from(sp.name.trim())[0] ?? ''}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block text-label',
                      sp.isArchived ? 'text-secondary line-through' : 'text-ink',
                    )}
                  >
                    {sp.name}
                  </span>
                  <span className="block text-small text-secondary">
                    {[
                      sp.contactPhone,
                      sp.contactTg ? `@${sp.contactTg}` : null,
                      sp.address,
                      sp.isArchived ? i18n.t('products.archived') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
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
        onOpenChange={(next) => !next && !busy && setDraft(null)}
        title={
          i18n.t(draft?.supplierId ? 'catalog.supplier.edit' : 'catalog.supplier.new') as string
        }
        actions={
          draft ? (
            <>
              <Button
                variant="primary"
                data-testid="supplier-save"
                busy={create.isPending || update.isPending}
                disabled={!draft.name.trim() || archive.isPending}
                onClick={save}
              >
                {draft.supplierId ? i18n.t('common.save') : i18n.t('common.create')}
              </Button>
              {draft.supplierId && !draft.archived ? (
                <Button
                  variant="ghost"
                  data-testid="supplier-archive"
                  disabled={busy}
                  onClick={() =>
                    confirmThen(
                      i18n.t('catalog.supplier.confirmArchive', { name: draft.name }) as string,
                      () => archive.mutate({ supplierId: draft.supplierId! }),
                    )
                  }
                >
                  <span className="text-danger">{i18n.t('common.archive')}</span>
                </Button>
              ) : null}
              {draft.supplierId && draft.archived ? (
                <Button
                  variant="secondary"
                  data-testid="supplier-unarchive"
                  disabled={busy}
                  onClick={() =>
                    update.mutate({ supplierId: draft.supplierId!, isArchived: false })
                  }
                >
                  {i18n.t('common.unarchive')}
                </Button>
              ) : null}
            </>
          ) : undefined
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
              type="tel"
              label={i18n.t('admin.field.phone') as string}
              value={draft.contactPhone}
              maxLength={32}
              placeholder="+998" /* i18n-exempt: a dialling code, the same in every language */
              onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })}
            />
            <Field
              label={i18n.t('admin.field.tgUsername') as string}
              value={draft.contactTg}
              maxLength={64}
              onChange={(e) => setDraft({ ...draft, contactTg: e.target.value.replace(/^@/, '') })}
            />
            <Field
              label={i18n.t('admin.field.address') as string}
              value={draft.address}
              maxLength={500}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
            <Field
              label={i18n.t('admin.field.notes') as string}
              value={draft.notes}
              maxLength={1000}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
