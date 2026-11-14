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
  useLeftField,
  useToast,
  rowGroupClass,
} from '@compass/ui';
import { CATALOG_TEXT_MAX, SLUG_MESSAGE } from '@compass/contracts/limits';
import { trpc } from '../../../lib/trpc';
import { useErrToast } from '../../../hooks/useErrToast';
import { useI18n, useProductNameParts } from '../../../hooks/useI18n';
import {
  CatalogNameFields,
  CatalogRowActions,
  CatalogRowHeader,
  CatalogToolbar,
  ReadOnlyHint,
  SortIndexField,
} from './CatalogParts';
import { useUndoToast } from '../../../hooks/useUndoToast';
import { useIsOrgAdmin } from '../../../hooks/useAdminAuthority';
import {
  CATALOG_LOCALES,
  EMPTY_NAMES,
  cleanNames,
  hasAnyName,
  namesForEdit,
  type CatalogNames,
} from './catalogNames';
import { useEditorSheet } from '../../../hooks/useDraftChanged';
import { codeFromName, slugIsValid } from '../../../lib/adminFields';
import { readSortIndex } from './sortIndex';

interface CategoryDraft {
  categoryId?: string;
  slug: string;
  names: CatalogNames;
  /** As typed (NEW-07); readSortIndex reads it. */
  sortText: string;
}

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
  const archivedToast = useUndoToast();
  const remove = trpc.admin.categoryDelete.useMutation({
    onSuccess: (_data, vars) => {
      void utils.admin.categoryList.invalidate();
      archivedToast(i18n.t('admin.toast.categoryArchived'), () =>
        update.mutate({ categoryId: vars.categoryId, isArchived: false }),
      );
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const editor = useEditorSheet(
    draft,
    setDraft,
    (d) => d.categoryId ?? 'new',
    create.isPending || update.isPending,
  );
  const sortIndex = draft ? readSortIndex(draft.sortText) : null;
  // D2 (2026-11-13): an empty short code is made from the name, unique in
  // the workspace; the field shows it as its placeholder.
  const slugTyped = draft?.slug.trim() ?? '';
  const autoSlug = draft
    ? codeFromName(
        CATALOG_LOCALES.map((l) => draft.names[l]),
        new Set(
          (categoriesQuery.data ?? []).filter((c) => c.id !== draft.categoryId).map((c) => c.slug),
        ),
        'category',
      )
    : '';
  const slugToSend = slugTyped || autoSlug;
  // Review MWA-04 (modern-web-guidance: validate-input-after-interaction):
  // the slug's error waits until the field is left, not mid-typing; a new
  // editor session starts over (the key is null between them).
  const slugLeft = useLeftField(draft ? (draft.categoryId ?? 'new') : null);

  return (
    <div className="px-4 py-3">
      {canWrite ? (
        <CatalogToolbar
          newLabel={i18n.t('catalog.category.newButton')}
          onNew={() => setDraft({ slug: '', names: { ...EMPTY_NAMES }, sortText: '100' })}
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
              const names = c.names;
              // The name in the reader's language; the others show below
              // it (CatalogRowHeader). Review COREWEB2-18: the title was
              // "primary (secondary)" for a reader of a second language,
              // and the line below repeated the primary.
              const name = productNameParts({ names });
              // Review ADM2-26 (2026-11-12): with no name at all the parts
              // read "—", never '', so `|| c.slug` never took over.
              const named = hasAnyName(names);
              const title = named ? name.primary : c.slug;
              return (
                <li key={c.id}>
                  <CatalogRowHeader
                    title={title}
                    titleLang={named ? name.primaryLang : undefined}
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
                          sortText: String(c.sortIndex),
                        })
                      }
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
            disabled={
              !draft || !slugIsValid(slugToSend) || !hasAnyName(draft.names) || sortIndex === null
            }
            onClick={() => {
              if (!draft || sortIndex === null) return;
              const names = cleanNames(draft.names);
              if (draft.categoryId) {
                update.mutate({
                  categoryId: draft.categoryId,
                  slug: slugToSend,
                  names,
                  sortIndex,
                });
              } else {
                create.mutate({ slug: slugToSend, names, sortIndex });
              }
            }}
          >
            {draft?.categoryId ? i18n.t('common.save') : i18n.t('common.create')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <CatalogNameFields
              names={draft.names}
              onChange={(names) => setDraft({ ...draft, names })}
              examples={CATEGORY_EXAMPLES}
            />
            {/* CAT-10 (2026-10-30): the server takes a-z, 0-9 and "-" only;
                anything else used to come back as 「出错了」. D2: below the names,
                which fill it when it is left empty. */}
            <Field
              label={i18n.t('admin.field.slug')}
              error={
                slugLeft.left && draft.slug && !slugIsValid(draft.slug)
                  ? i18n.t(SLUG_MESSAGE.category)
                  : null
              }
            >
              <Input
                value={draft.slug}
                {...slugLeft.inputProps}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
                maxLength={CATALOG_TEXT_MAX.categorySlug}
                placeholder={autoSlug}
              />
            </Field>
            <SortIndexField
              text={draft.sortText}
              onText={(sortText) => setDraft({ ...draft, sortText })}
            />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
