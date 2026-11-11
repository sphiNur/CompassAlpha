/**
 * Admin → Catalog → Categories: the list and its editor. Review ADM2-11
 * (2026-11-11): one file per catalog section; the five shared
 * CatalogSections.tsx (1,923 lines), and the parts they repeated are in
 * CatalogParts.tsx.
 */
import { useState } from 'react';
import {
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  Sheet,
  useToast,
  rowGroupClass,
} from '@compass/ui';
import { CATALOG_TEXT_MAX } from '@compass/contracts/limits';
import { trpc } from '../../../lib/trpc';
import { useErrToast } from '../../../hooks/useErrToast';
import { useI18n, useProductNameParts } from '../../../hooks/useI18n';
import {
  CatalogNameFields,
  CatalogRowActions,
  CatalogRowHeader,
  CatalogToolbar,
  ReadOnlyHint,
  useIsOrgAdmin,
} from './CatalogParts';
import {
  EMPTY_NAMES,
  cleanNames,
  hasAnyName,
  namesForEdit,
  type CatalogNames,
} from './catalogNames';
import { useEditorSheet } from '../../../hooks/useDraftChanged';

interface CategoryDraft {
  categoryId?: string;
  slug: string;
  names: CatalogNames;
  sortIndex: number;
}

/** Category slugs: what CreateCategoryInput accepts. */
const SLUG_RE = /^[a-z0-9-]+$/;

/** Example names, each in its own field's language. */
const CATEGORY_EXAMPLES: CatalogNames = {
  uz: 'Sabzavotlar',
  ru: 'Овощи', // i18n-exempt: an example word in the Russian name field
  en: 'Vegetables',
  zh: '蔬菜', // i18n-exempt: an example word in the Chinese name field
};

export function CategoriesSection() {
  const categoriesQuery = trpc.admin.categoryList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const productNameParts = useProductNameParts();
  const canWrite = useIsOrgAdmin();
  const [draft, setDraft] = useState<CategoryDraft | null>(null);

  const create = trpc.admin.categoryCreate.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.success(i18n.t('admin.toast.categoryCreated'));
      setDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const update = trpc.admin.categoryUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.success(i18n.t('admin.toast.categoryUpdated'));
      setDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const remove = trpc.admin.categoryDelete.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.info(i18n.t('admin.toast.categoryArchived'));
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const editor = useEditorSheet(
    draft,
    setDraft,
    (d) => d.categoryId ?? 'new',
    create.isPending || update.isPending,
  );

  return (
    <div className="px-4 py-3">
      {canWrite ? (
        <CatalogToolbar
          newLabel={i18n.t('catalog.category.newButton')}
          onNew={() => setDraft({ slug: '', names: { ...EMPTY_NAMES }, sortIndex: 100 })}
        />
      ) : (
        <ReadOnlyHint />
      )}
      <DataState
        query={categoriesQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('catalog.category.emptyTitle')}
            description={i18n.t('catalog.category.emptyBody')}
          />
        }
      >
        {(rows) => (
          <ul className={rowGroupClass} role="list">
            {rows.map((c) => {
              const names = c.names as Record<string, string>;
              // The name in the reader's language; the others show below
              // it (CatalogRowHeader). Review COREWEB2-18: the title was
              // "primary (secondary)" for a reader of a second language,
              // and the line below repeated the primary.
              const name = productNameParts({ names });
              const title = name.primary || c.slug;
              return (
                <li key={c.id}>
                  <CatalogRowHeader
                    title={title}
                    titleLang={name.primary ? name.primaryLang : undefined}
                    names={names}
                    meta={i18n.t('catalog.category.meta', { slug: c.slug, sort: c.sortIndex })}
                    archived={c.isArchived}
                  />
                  {canWrite ? (
                    <CatalogRowActions
                      archived={c.isArchived}
                      onEdit={() =>
                        setDraft({
                          categoryId: c.id,
                          slug: c.slug,
                          names: namesForEdit(names),
                          sortIndex: c.sortIndex,
                        })
                      }
                      confirmArchive={i18n.t('catalog.category.confirmArchive', { name: title })}
                      onArchive={() => remove.mutate({ categoryId: c.id })}
                      onUnarchive={() => update.mutate({ categoryId: c.id, isArchived: false })}
                      unarchiving={update.isPending && update.variables?.categoryId === c.id}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      <Sheet
        {...editor}
        title={i18n.t(draft?.categoryId ? 'catalog.category.edit' : 'catalog.category.new')}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={!draft?.slug.trim() || !SLUG_RE.test(draft.slug) || !hasAnyName(draft.names)}
            onClick={() => {
              if (!draft) return;
              const names = cleanNames(draft.names);
              if (draft.categoryId) {
                update.mutate({
                  categoryId: draft.categoryId,
                  slug: draft.slug,
                  names,
                  sortIndex: draft.sortIndex,
                });
              } else {
                create.mutate({ slug: draft.slug, names, sortIndex: draft.sortIndex });
              }
            }}
          >
            {draft?.categoryId ? i18n.t('common.save') : i18n.t('common.create')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            {/* CAT-10 (2026-10-30): the server takes a-z, 0-9 and "-" only;
                anything else used to come back as 「出错了」. */}
            <Field
              label={i18n.t('admin.field.slug')}
              required
              error={
                draft.slug && !SLUG_RE.test(draft.slug)
                  ? i18n.t('catalog.category.slugInvalid')
                  : null
              }
            >
              <Input
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
                maxLength={CATALOG_TEXT_MAX.categorySlug}
                placeholder={i18n.t('catalog.category.slugPlaceholder')}
              />
            </Field>
            <CatalogNameFields
              names={draft.names}
              onChange={(names) => setDraft({ ...draft, names })}
              examples={CATEGORY_EXAMPLES}
            />
            <Field label={i18n.t('admin.field.sortIndex')}>
              <Input
                type="number"
                value={String(draft.sortIndex)}
                onChange={(e) => setDraft({ ...draft, sortIndex: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
