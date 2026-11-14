/**
 * Admin → Catalog → Products: search, import, the list and its editor.
 * Review ADM2-11 (2026-11-11): one file per catalog section.
 */
import { useDeferredValue, useMemo, useState } from 'react';
import {
  Button,
  DataState,
  EmptyState,
  Field,
  Input,
  SearchInput,
  Select,
  Sheet,
  useToast,
  rowGroupClass,
} from '@compass/ui';
import { CATALOG_TEXT_MAX, SKU_STEPS, SKU_UNITS } from '@compass/contracts/limits';
import type { SkuStep, SkuUnit } from '@compass/contracts';
import { defaultStepForUnit, snapStepToCanonical, stepAfterUnitChange } from './skuStep';
import { trpc } from '../../../lib/trpc';
import { useErrToast } from '../../../hooks/useErrToast';
import { formatQty } from '../../../lib/format';
import { matchesNameLike, normalizeQuery } from '../../../lib/searchMatch';
import { useI18n, useProductName, useProductNameParts, useUnitLabel } from '../../../hooks/useI18n';
import { useAnnounce } from '../../../hooks/useAnnounce';
import { CatalogImportSheet } from './CatalogImportSheet';
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
  EMPTY_NAMES,
  cleanNames,
  hasAnyName,
  namesForEdit,
  type CatalogNames,
} from './catalogNames';
import { useEditorSheet } from '../../../hooks/useDraftChanged';
import { readSortIndex } from './sortIndex';
import { lastSkuCategory, pickNewSkuCategory, rememberSkuCategory } from './skuCategory';

interface SkuDraft {
  skuId?: string;
  categoryId: string | null;
  code: string;
  names: CatalogNames;
  /** 2026-07-30: fixed vocabulary — see SkuUnitSchema in @compass/contracts. */
  unit: SkuUnit;
  /** M3.14 + 2026-07-30: only the canonical grid — see SkuStepSchema. */
  step: SkuStep;
  /** S2: the step was picked by hand in this editor; a unit change keeps it. */
  stepTouched: boolean;
  /** As typed (NEW-07); readSortIndex reads it. */
  sortText: string;
}

/** Example names, each in its own field's language. */
const SKU_EXAMPLES: CatalogNames = {
  uz: 'Pomidor',
  ru: 'Помидор', // i18n-exempt: an example word in the Russian name field
  en: 'Tomato',
  zh: '西红柿', // i18n-exempt: an example word in the Chinese name field
};

/**
 * Snap a legacy unit string onto the fixed SkuUnitSchema vocabulary.
 *
 * Prod rows are already migrated (0036), but a dev DB seeded before the
 * restriction may still carry 个 / ta / karobka / "pcs（500g）" etc. The
 * edit sheet has to preselect SOMETHING valid or the Select goes blank
 * and Save submits a rejected value.
 */
function snapUnitToCanonical(unit: string): SkuUnit {
  if ((SKU_UNITS as readonly string[]).includes(unit)) return unit as SkuUnit;
  if (unit === 'g') return 'kg';
  if (unit === 'karobka') return 'box';
  if (unit === 'boglima') return 'bunch';
  return 'pcs';
}

export function SkusSection() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const skusQuery = trpc.admin.skuList.useQuery({ includeArchived });
  const categoriesQuery = trpc.admin.categoryList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const productName = useProductName();
  const productNameParts = useProductNameParts();
  const canWrite = useIsOrgAdmin();
  const [draft, setDraft] = useState<SkuDraft | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // M1.10 (2026-05-08): cross-language SKU search.
  const [searchQuery, setSearchQuery] = useState('');
  // Review MWD-08 (modern-web-guidance: performance, INP): the field
  // updates at once; the filter and the list follow the deferred query,
  // as on the order page (useCatalogFilter.ts), and run once, not twice.
  const deferredQuery = useDeferredValue(searchQuery);
  const tokens = useMemo(() => normalizeQuery(deferredQuery), [deferredQuery]);
  const filteredSkus = useMemo(
    () =>
      tokens && skusQuery.data
        ? skusQuery.data.filter((sk) => matchesNameLike({ names: sk.names, code: sk.code }, tokens))
        : null,
    [tokens, skusQuery.data],
  );
  // A11Y-12 (2026-10-31): read the number of matches out once typing
  // settles: the length of the list below.
  const matchCount = filteredSkus ? filteredSkus.length : null;
  useAnnounce(
    matchCount === null
      ? null
      : matchCount === 0
        ? i18n.t('admin.search.noMatches.title')
        : i18n.t('a11y.results.products', { n: matchCount }),
  );

  const create = trpc.admin.skuCreate.useMutation({
    onSuccess: (_data, vars) => {
      // UX-18: the next new product starts in this category.
      rememberSkuCategory(vars.categoryId ?? null);
      void utils.admin.skuList.invalidate();
      toast.success(i18n.t('admin.toast.skuCreated'));
      setDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const update = trpc.admin.skuUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.skuList.invalidate();
      toast.success(i18n.t('admin.toast.skuUpdated'));
      setDraft(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const archivedToast = useUndoToast();
  const remove = trpc.admin.skuDelete.useMutation({
    onSuccess: (_data, vars) => {
      void utils.admin.skuList.invalidate();
      archivedToast(i18n.t('admin.toast.skuArchived'), () =>
        update.mutate({ skuId: vars.skuId, isArchived: false }),
      );
    },
    onError: errToast('common.errors.actionFailed'),
  });

  // ADM2-25: a product without a category says nothing about it (UI-3);
  // its facts line used to start with "— · ". ADM2-26: the category in the
  // reader's language only, not "primary (secondary)" inline (UI-4), and
  // its slug when it has no name (the parts read "—" then, never '').
  const categoryName = (id: string | null): string | null => {
    if (!id) return null;
    const c = categoriesQuery.data?.find((x) => x.id === id);
    if (!c) return i18n.t('common.unknownCategory');
    return hasAnyName(c.names) ? productNameParts({ names: c.names }).primary : c.slug;
  };

  const editor = useEditorSheet(
    draft,
    setDraft,
    (d) => d.skuId ?? 'new',
    create.isPending || update.isPending,
  );
  const sortIndex = draft ? readSortIndex(draft.sortText) : null;

  return (
    <div className="px-4 py-3">
      {canWrite ? null : <ReadOnlyHint />}
      <CatalogToolbar
        newLabel={canWrite ? i18n.t('catalog.sku.new') : undefined}
        onNew={() =>
          setDraft({
            categoryId: pickNewSkuCategory([lastSkuCategory()], categoriesQuery.data),
            code: '',
            names: { ...EMPTY_NAMES },
            unit: 'pcs',
            step: defaultStepForUnit('pcs'),
            stepTouched: false,
            sortText: '100',
          })
        }
        showArchived={includeArchived}
        onShowArchivedChange={setIncludeArchived}
      >
        {canWrite ? (
          <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>
            {i18n.t('catalog.import.button')}
          </Button>
        ) : null}
      </CatalogToolbar>
      <div className="mb-3">
        <SearchInput
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onClear={() => setSearchQuery('')}
          placeholder={i18n.t('admin.search.skusPlaceholder')}
          clearAriaLabel={i18n.t('common.clear')}
        />
      </div>

      <DataState
        query={skusQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('admin.empty.noSkus.title')}
            description={i18n.t('admin.empty.noSkus.description')}
          />
        }
      >
        {(rows) => {
          const filtered = filteredSkus ?? rows;
          return (
            <ul className={rowGroupClass} role="list">
              {filtered.length === 0 && tokens ? (
                <li>
                  <EmptyState
                    title={i18n.t('admin.search.noMatches.title')}
                    description={i18n.t('admin.search.noMatches.description')}
                  />
                </li>
              ) : null}
              {filtered.map((sk) => {
                const names = sk.names;
                // The name in the reader's language only; the others list
                // under it (CategoriesSection, COREWEB2-18).
                const name = productNameParts({ names });
                // ADM2-26: as the categories, the code takes over only when
                // there is no name at all.
                const named = hasAnyName(names);
                const primary = named ? name.primary : sk.code || i18n.t('common.unknownProduct');
                return (
                  // Review MWD-07 (modern-web-guidance:
                  // defer-rendering-heavy-content): the whole catalog is
                  // mounted; rows off screen skip layout and paint, as on
                  // the order page (SkuRow.tsx). 120px: header and actions.
                  <li
                    key={sk.id}
                    className="[content-visibility:auto] [contain-intrinsic-size:auto_120px]"
                  >
                    <CatalogRowHeader
                      title={primary}
                      titleLang={named ? name.primaryLang : undefined}
                      names={names}
                      meta={[
                        categoryName(sk.categoryId),
                        unitLabel.uncounted(sk.unit),
                        // DX-CAT-8 (2026-11-01): "0.5", not the column's "0.500".
                        i18n.t('catalog.sku.stepMeta', { step: formatQty(sk.step) }),
                        sk.code,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      archived={sk.isArchived}
                    />
                    {canWrite ? (
                      <CatalogRowActions
                        archived={sk.isArchived}
                        onEdit={() =>
                          setDraft({
                            skuId: sk.id,
                            categoryId: sk.categoryId,
                            code: sk.code ?? '',
                            names: namesForEdit(names),
                            // Snap legacy values onto the contract enums so
                            // both Selects have a valid initial selection.
                            unit: snapUnitToCanonical(sk.unit),
                            step: snapStepToCanonical(sk.step),
                            stepTouched: false,
                            sortText: String(sk.sortIndex),
                          })
                        }
                        onArchive={() => remove.mutate({ skuId: sk.id })}
                        onUnarchive={() => update.mutate({ skuId: sk.id, isArchived: false })}
                        unarchiving={update.isPending && update.variables?.skuId === sk.id}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          );
        }}
      </DataState>

      <CatalogImportSheet open={importOpen} onOpenChange={setImportOpen} />

      <Sheet
        {...editor}
        title={i18n.t(draft?.skuId ? 'catalog.sku.edit' : 'catalog.sku.new')}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={
              !draft || !hasAnyName(draft.names) || !draft.unit.trim() || sortIndex === null
            }
            onClick={() => {
              if (!draft || sortIndex === null) return;
              const names = cleanNames(draft.names);
              if (draft.skuId) {
                update.mutate({
                  skuId: draft.skuId,
                  categoryId: draft.categoryId,
                  code: draft.code || null,
                  names,
                  unit: draft.unit,
                  step: draft.step,
                  sortIndex,
                });
              } else {
                create.mutate({
                  categoryId: draft.categoryId,
                  code: draft.code || null,
                  names,
                  unit: draft.unit,
                  step: draft.step,
                  sortIndex,
                });
              }
            }}
          >
            {draft?.skuId ? i18n.t('common.save') : i18n.t('common.create')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <CatalogNameFields
              names={draft.names}
              onChange={(names) => setDraft({ ...draft, names })}
              examples={SKU_EXAMPLES}
              autoFocus
            />
            <Field label={i18n.t('admin.field.category')}>
              <Select
                value={draft.categoryId ?? ''}
                onChange={(e) => setDraft({ ...draft, categoryId: e.target.value || null })}
              >
                <option value="">—</option>
                {/* 2026-10-21 audit CA-40 / E-16: archived categories are
                    not offered — except the one this SKU already uses, so
                    the Select doesn't go blank and silently re-file it. */}
                {(categoriesQuery.data ?? [])
                  .filter((c) => !c.isArchived || c.id === draft.categoryId)
                  .map((c) => {
                    const n = c.names;
                    return (
                      <option key={c.id} value={c.id}>
                        {hasAnyName(n) ? productName({ names: n }) : c.slug}
                        {c.isArchived ? ` (${i18n.t('common.archived')})` : ''}
                      </option>
                    );
                  })}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              {/* 2026-07-30: unit and step are Selects over the contract
                  enums (SkuUnitSchema / SkuStepSchema) — free-text units
                  produced 个 / ta / Pcs / karobka duplicates in prod. */}
              <Field label={i18n.t('admin.field.unit')} required>
                <Select
                  value={draft.unit}
                  onChange={(e) => {
                    // S2 (2026-11-13): the step follows the unit (kg → 0.5)
                    // until it is picked by hand.
                    const unit = e.target.value as SkuUnit;
                    setDraft({ ...draft, unit, step: stepAfterUnitChange(unit, draft) });
                  }}
                >
                  {/* R2-COPY-3: the localised unit, not the stored code. */}
                  {SKU_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {unitLabel.uncounted(u)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={i18n.t('admin.field.step')}>
                <Select
                  value={draft.step}
                  onChange={(e) =>
                    setDraft({ ...draft, step: e.target.value as SkuStep, stepTouched: true })
                  }
                >
                  {/* Review ADM2-43 (2026-11-11): «0,5» in ru / uz, like the list. */}
                  {SKU_STEPS.map((s) => (
                    <option key={s} value={s}>
                      {formatQty(s)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={i18n.t('admin.field.code')}>
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                maxLength={CATALOG_TEXT_MAX.skuCode}
                placeholder={i18n.t('common.optional')}
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
