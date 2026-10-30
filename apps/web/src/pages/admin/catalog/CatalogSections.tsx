/**
 * Admin → Catalog CRUD sections — extracted verbatim from AdminPage.tsx
 * (Phase 5 step 2, FRONTEND_AUDIT_2026-07.md admin split).
 *
 *   - CategoriesSection / SkusSection / SuppliersSection /
 *     ExpenseTemplatesSection / DishesSection — the five list-editor
 *     surfaces (New button + DataState + card list + create/edit Sheet).
 *
 * Draft interfaces and helpers (snapStepToCanonical, EMPTY_DISH) are
 * internal. The audit's ListEditor/NameFieldsML consolidation happens
 * on top of this split as its own pass.
 */
import { useMemo, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardMeta,
  CardTitle,
  DataState,
  EmptyState,
  Field,
  Input,
  SearchInput,
  SectionLabel,
  Select,
  Sheet,
  Switch,
  useToast,
} from '@compass/ui';
import { SKU_STEPS, SKU_UNITS } from '@compass/contracts';
import type { SkuStep, SkuUnit } from '@compass/contracts';
import { LANGUAGE_NATIVE_NAMES } from '@compass/i18n';
import { snapStepToCanonical } from './skuStep';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { formatMoney, formatQty } from '../../../lib/format';
import { matchesNameLike, normalizeQuery } from '../../../lib/searchMatch';
import { useI18n, useProductName } from '../../../hooks/useI18n';
import { nativeConfirm } from '../shared';
import { CatalogImportSheet } from './CatalogImportSheet';

/**
 * 2026-10-21 audit CA-16: every catalog write below (categories, SKUs,
 * suppliers, expense templates) is `requireOrgAdmin` on the server, but
 * the controls rendered for anyone who could open Admin (`users.manage`),
 * so a store manager got a FORBIDDEN on save. Without `org.admin` the
 * sections are now a read-only list.
 */
function useIsOrgAdmin(): boolean {
  return useAuthStore((s) => s.session?.permissions.includes('org.admin') ?? false);
}

/** Shown in place of the "+ New" row when the catalog is read-only. */
function ReadOnlyHint() {
  const i18n = useI18n();
  return (
    <p className="mb-3 text-old-label text-[var(--c-fg-muted)]">{i18n.t('catalog.readOnlyHint')}</p>
  );
}

/**
 * 2026-10-21 CA-40: names need at least one locale, not all four (same rule
 * as dishes). Empty locales are omitted rather than sent as '' so
 * `pickName`'s `??` fallback chain shows another language instead of a blank.
 */
interface NameDraft {
  nameUz: string;
  nameRu: string;
  nameEn: string;
  nameZh: string;
}

function namesFromDraft(d: NameDraft): Record<string, string> {
  const out: Record<string, string> = {};
  const pairs: Array<[string, string]> = [
    ['uz', d.nameUz],
    ['ru', d.nameRu],
    ['en', d.nameEn],
    ['zh', d.nameZh],
  ];
  for (const [k, v] of pairs) if (v.trim()) out[k] = v.trim();
  return out;
}

function hasAnyName(d: NameDraft | null | undefined): boolean {
  return !!d && Object.keys(namesFromDraft(d)).length > 0;
}

interface CategoryDraft {
  categoryId?: string;
  slug: string;
  // 4-language draft (2026-05-05). Server enforces all 4 non-empty.
  nameUz: string;
  nameRu: string;
  nameEn: string;
  nameZh: string;
  sortIndex: number;
}


/**
 * Closing a catalog editor by Esc, a backdrop tap or Telegram's back button
 * used to drop whatever was typed, and could close mid-save (atlas CAT-18).
 * While saving the sheet stays open; with unsaved edits it asks first.
 */
/** Category slugs: what CreateCategoryInput accepts. */
const SLUG_RE = /^[a-z0-9-]+$/;

function useEditorClose<T>(draft: T | null, setDraft: (d: null) => void, busy: boolean) {
  const i18n = useI18n();
  const opened = useRef<string | null>(null);
  if (draft === null) opened.current = null;
  else if (opened.current === null) opened.current = JSON.stringify(draft);
  return (open: boolean) => {
    if (open || busy) return;
    if (draft !== null && JSON.stringify(draft) !== opened.current) {
      nativeConfirm(i18n.t('catalog.confirm.discardEdits'), () => setDraft(null));
      return;
    }
    setDraft(null);
  };
}

export function CategoriesSection() {
  const categoriesQuery = trpc.admin.categoryList.useQuery();
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const productName = useProductName();
  const canWrite = useIsOrgAdmin();
  const [draft, setDraft] = useState<CategoryDraft | null>(null);

  const create = trpc.admin.categoryCreate.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.success(i18n.t('admin.toast.categoryCreated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const update = trpc.admin.categoryUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.success(i18n.t('admin.toast.categoryUpdated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const remove = trpc.admin.categoryDelete.useMutation({
    onSuccess: () => {
      void utils.admin.categoryList.invalidate();
      toast.info(i18n.t('admin.toast.categoryArchived'));
    },
    onError: errToast('common.error'),
  });

  const closeEditor = useEditorClose(draft, setDraft, create.isPending || update.isPending);

  return (
    <div className="px-4 py-3">
      {canWrite ? (
        <div className="mb-3">
          <Button
            size="sm"
            onClick={() =>
              setDraft({
                slug: '',
                nameUz: '',
                nameRu: '',
                nameEn: '',
                nameZh: '',
                sortIndex: 100,
              })
            }
          >
            + {i18n.t('catalog.category.newButton')}
          </Button>
        </div>
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
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((c) => {
              const names = c.names as Record<string, string>;
              // Title shows the name in the user's preferred locale,
              // with the other 3 langs in a 12px row below so admins
              // can verify the catalog is fully translated at a glance.
              const otherLangs = ['uz', 'ru', 'en', 'zh']
                .filter((l) => names[l] && names[l] !== productName({ names }))
                .map((l) => names[l])
                .join(' · ');
              return (
                <Card key={c.id}>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{productName({ names }) || c.slug}</CardTitle>
                      {otherLangs ? (
                        <div className="mt-0.5 truncate text-old-label text-[var(--c-fg-muted)]">
                          {otherLangs}
                        </div>
                      ) : null}
                      <CardMeta>
                        {i18n.t('catalog.category.meta', { slug: c.slug, sort: c.sortIndex })}
                      </CardMeta>
                    </div>
                    {c.isArchived ? (
                      <Badge tone="muted">{i18n.t('common.archived')}</Badge>
                    ) : null}
                  </CardHeader>
                  {canWrite ? (
                    <div className="flex gap-2 border-t border-[var(--c-divider)] px-4 py-2">
                      <Button
                        size="sm"
                        variant="pearl"
                        onClick={() =>
                          setDraft({
                            categoryId: c.id,
                            slug: c.slug,
                            nameUz: names.uz ?? '',
                            nameRu: names.ru ?? '',
                            nameEn: names.en ?? '',
                            nameZh: names.zh ?? '',
                            sortIndex: c.sortIndex,
                          })
                        }
                      >
                        {i18n.t('common.edit')}
                      </Button>
                      {!c.isArchived ? (
                        <Button
                          size="sm"
                          variant="danger-ghost"
                          onClick={() =>
                            nativeConfirm(
                              i18n.t('catalog.category.confirmArchive', {
                                name: productName({ names }) || c.slug,
                              }),
                              () => remove.mutate({ categoryId: c.id }),
                            )
                          }
                        >
                          {i18n.t('common.archive')}
                        </Button>
                      ) : (
                        // 2026-10-21 audit CA-40 / E-16: categoryUpdate has
                        // always accepted isArchived, but there was no way
                        // back from an archive in the UI.
                        <Button
                          size="sm"
                          variant="pearl"
                          loading={update.isPending && update.variables?.categoryId === c.id}
                          onClick={() => update.mutate({ categoryId: c.id, isArchived: false })}
                        >
                          {i18n.t('common.unarchive')}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>

      <Sheet
        open={!!draft}
        onOpenChange={closeEditor}
        title={i18n.t(draft?.categoryId ? 'catalog.category.edit' : 'catalog.category.new')}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={
              !draft?.slug.trim() || !SLUG_RE.test(draft.slug) || !hasAnyName(draft)
            }
            onClick={() => {
              if (!draft) return;
              const names = namesFromDraft(draft);
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
              label={`${i18n.t('admin.field.slug')} *`}
              hint={
                draft.slug && !SLUG_RE.test(draft.slug)
                  ? i18n.t('catalog.category.slugInvalid')
                  : undefined
              }
            >
              <Input
                value={draft.slug}
                onChange={(e) => setDraft({ ...draft, slug: e.target.value.toLowerCase() })}
                maxLength={64}
                invalid={!!draft.slug && !SLUG_RE.test(draft.slug)}
                placeholder={i18n.t('catalog.category.slugPlaceholder')}
              />
            </Field>
            {/* CAT-10: one name in any language is enough (the server's rule);
                the four fields used to be starred as if all were required. */}
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('catalog.names.atLeastOne')}
            </p>
            <Field label={`${i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES.uz })}`}>
              <Input
                value={draft.nameUz}
                onChange={(e) => setDraft({ ...draft, nameUz: e.target.value })}
                maxLength={200}
                placeholder="Sabzavotlar" /* i18n-exempt: example word FOR that specific language field */
              />
            </Field>
            <Field label={`${i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES.ru })}`}>
              <Input
                value={draft.nameRu}
                onChange={(e) => setDraft({ ...draft, nameRu: e.target.value })}
                maxLength={200}
                placeholder="Овощи"
              />
            </Field>
            <Field label={`${i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES.en })}`}>
              <Input
                value={draft.nameEn}
                onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })}
                maxLength={200}
                placeholder="Vegetables" /* i18n-exempt: example word FOR that specific language field */
              />
            </Field>
            <Field label={`${i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES.zh })}`}>
              <Input
                value={draft.nameZh}
                onChange={(e) => setDraft({ ...draft, nameZh: e.target.value })}
                maxLength={200}
                placeholder="蔬菜"
              />
            </Field>
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

interface SkuDraft {
  skuId?: string;
  categoryId: string | null;
  code: string;
  // 4-language draft (2026-05-05). Server enforces all 4 non-empty.
  nameUz: string;
  nameRu: string;
  nameEn: string;
  nameZh: string;
  /** 2026-07-30: fixed vocabulary — see SkuUnitSchema in @compass/contracts. */
  unit: SkuUnit;
  /** M3.14 + 2026-07-30: only the canonical grid — see SkuStepSchema. */
  step: SkuStep;
  sortIndex: number;
}

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
  const productName = useProductName();
  const canWrite = useIsOrgAdmin();
  const [draft, setDraft] = useState<SkuDraft | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // M1.10 (2026-05-08): cross-language SKU search.
  const [searchQuery, setSearchQuery] = useState('');
  const tokens = useMemo(() => normalizeQuery(searchQuery), [searchQuery]);

  const create = trpc.admin.skuCreate.useMutation({
    onSuccess: () => {
      void utils.admin.skuList.invalidate();
      toast.success(i18n.t('admin.toast.skuCreated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const update = trpc.admin.skuUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.skuList.invalidate();
      toast.success(i18n.t('admin.toast.skuUpdated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const remove = trpc.admin.skuDelete.useMutation({
    onSuccess: () => {
      void utils.admin.skuList.invalidate();
      toast.info(i18n.t('admin.toast.skuArchived'));
    },
    onError: errToast('common.error'),
  });

  const categoryName = (id: string | null): string => {
    if (!id) return '—';
    const c = categoriesQuery.data?.find((x) => x.id === id);
    if (!c) return id.slice(0, 6);
    return productName({ names: c.names as Record<string, string> }) || c.slug;
  };

  const closeEditor = useEditorClose(draft, setDraft, create.isPending || update.isPending);

  return (
    <div className="px-4 py-3">
      {canWrite ? null : <ReadOnlyHint />}
      <div className="mb-3 flex items-center gap-2">
        {canWrite ? (
          <Button
            size="sm"
            onClick={() =>
              setDraft({
                categoryId: null,
                code: '',
                nameUz: '',
                nameRu: '',
                nameEn: '',
                nameZh: '',
                unit: 'pcs',
                step: '1',
                sortIndex: 100,
              })
            }
          >
            + {i18n.t('catalog.sku.new')}
          </Button>
        ) : null}
        {canWrite ? (
          <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>
            {i18n.t('catalog.import.button')}
          </Button>
        ) : null}
        <div className="ml-auto">
          <Switch
            label={i18n.t('admin.label.showArchived')}
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
        </div>
      </div>
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
        empty={<EmptyState title={i18n.t('admin.empty.noSkus.title')} description={i18n.t('admin.empty.noSkus.description')} />}
      >
        {(rows) => {
          const filtered = tokens
            ? rows.filter((sk) =>
                matchesNameLike(
                  { names: sk.names as Record<string, string> | null, code: sk.code },
                  tokens,
                ),
              )
            : rows;
          return (
          <ul className="flex flex-col gap-2" role="list">
            {filtered.length === 0 && tokens ? (
              <li>
                <EmptyState
                  title={i18n.t('admin.search.noMatches.title')}
                  description={i18n.t('admin.search.noMatches.description')}
                />
              </li>
            ) : null}
            {filtered.map((sk) => {
              const names = sk.names as Record<string, string>;
              const primary = productName({ names }) || sk.code || sk.id.slice(0, 6);
              const otherLangs = ['uz', 'ru', 'en', 'zh']
                .filter((l) => names[l] && names[l] !== primary)
                .map((l) => names[l])
                .join(' · ');
              return (
                <Card key={sk.id}>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{primary}</CardTitle>
                      {otherLangs ? (
                        <div className="mt-0.5 truncate text-old-label text-[var(--c-fg-muted)]">
                          {otherLangs}
                        </div>
                      ) : null}
                      <CardMeta>
                        {categoryName(sk.categoryId)} · {sk.unit} ·{' '}
                        {i18n.t('catalog.sku.stepMeta', { step: sk.step })}
                        {sk.code ? ` · ${sk.code}` : ''}
                      </CardMeta>
                    </div>
                    {sk.isArchived ? (
                      <Badge tone="muted">{i18n.t('common.archived')}</Badge>
                    ) : null}
                  </CardHeader>
                  {canWrite ? (
                    <div className="flex gap-2 border-t border-[var(--c-divider)] px-4 py-2">
                      <Button
                        size="sm"
                        variant="pearl"
                        onClick={() =>
                          setDraft({
                            skuId: sk.id,
                            categoryId: sk.categoryId,
                            code: sk.code ?? '',
                            nameUz: names.uz ?? '',
                            nameRu: names.ru ?? '',
                            nameEn: names.en ?? '',
                            nameZh: names.zh ?? '',
                            // Snap legacy values onto the contract enums so
                            // both Selects have a valid initial selection.
                            unit: snapUnitToCanonical(sk.unit),
                            step: snapStepToCanonical(sk.step),
                            sortIndex: sk.sortIndex,
                          })
                        }
                      >
                        {i18n.t('common.edit')}
                      </Button>
                      {!sk.isArchived ? (
                        <Button
                          size="sm"
                          variant="danger-ghost"
                          onClick={() =>
                            nativeConfirm(
                              i18n.t('catalog.sku.confirmArchive', { name: primary }),
                              () =>
                              remove.mutate({ skuId: sk.id }),
                            )
                          }
                        >
                          {i18n.t('common.archive')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="pearl"
                          onClick={() => update.mutate({ skuId: sk.id, isArchived: false })}
                        >
                          {i18n.t('common.unarchive')}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </ul>
          );
        }}
      </DataState>

      <CatalogImportSheet open={importOpen} onOpenChange={setImportOpen} />

      <Sheet
        open={!!draft}
        onOpenChange={closeEditor}
        title={i18n.t(draft?.skuId ? 'catalog.sku.edit' : 'catalog.sku.new')}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={
              !hasAnyName(draft) || !draft?.unit.trim()
            }
            onClick={() => {
              if (!draft) return;
              const names = namesFromDraft(draft);
              if (draft.skuId) {
                update.mutate({
                  skuId: draft.skuId,
                  categoryId: draft.categoryId,
                  code: draft.code || null,
                  names,
                  unit: draft.unit,
                  step: draft.step,
                  sortIndex: draft.sortIndex,
                });
              } else {
                create.mutate({
                  categoryId: draft.categoryId,
                  code: draft.code || null,
                  names,
                  unit: draft.unit,
                  step: draft.step,
                  sortIndex: draft.sortIndex,
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
            {/* 4-language inputs (2026-05-05). Order is uz/ru/en/zh — uz
                first because that's the working language in this market.
                CAT-10: one of them is enough. */}
            <p className="text-old-label text-[var(--c-fg-muted)]">
              {i18n.t('catalog.names.atLeastOne')}
            </p>
            <Field label={`${i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES.uz })}`}>
              <Input
                value={draft.nameUz}
                onChange={(e) => setDraft({ ...draft, nameUz: e.target.value })}
                maxLength={200}
                placeholder="Pomidor" /* i18n-exempt: example word FOR that specific language field */
                autoFocus
              />
            </Field>
            <Field label={`${i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES.ru })}`}>
              <Input
                value={draft.nameRu}
                onChange={(e) => setDraft({ ...draft, nameRu: e.target.value })}
                maxLength={200}
                placeholder="Помидор"
              />
            </Field>
            <Field label={`${i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES.en })}`}>
              <Input
                value={draft.nameEn}
                onChange={(e) => setDraft({ ...draft, nameEn: e.target.value })}
                maxLength={200}
                placeholder="Tomato" /* i18n-exempt: example word FOR that specific language field */
              />
            </Field>
            <Field label={`${i18n.t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES.zh })}`}>
              <Input
                value={draft.nameZh}
                onChange={(e) => setDraft({ ...draft, nameZh: e.target.value })}
                maxLength={200}
                placeholder="西红柿"
              />
            </Field>
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
                    const n = c.names as Record<string, string>;
                    return (
                      <option key={c.id} value={c.id}>
                        {productName({ names: n }) || c.slug}
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
              <Field label={`${i18n.t('admin.field.unit')} *`}>
                <Select
                  value={draft.unit}
                  onChange={(e) => setDraft({ ...draft, unit: e.target.value as SkuUnit })}
                >
                  {SKU_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={i18n.t('admin.field.step')}>
                <Select
                  value={draft.step}
                  onChange={(e) => setDraft({ ...draft, step: e.target.value as SkuStep })}
                >
                  {SKU_STEPS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label={i18n.t('admin.field.code')}>
              <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} maxLength={64} placeholder={i18n.t('common.optional')} />
            </Field>
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

interface SupplierDraft {
  supplierId?: string;
  name: string;
  contactPhone: string;
  contactTg: string;
  address: string;
  notes: string;
  isArchived: boolean;
}

export function SuppliersSection() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const suppliersQuery = trpc.admin.supplierList.useQuery({ includeArchived });
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  const canWrite = useIsOrgAdmin();
  const [draft, setDraft] = useState<SupplierDraft | null>(null);

  const create = trpc.admin.supplierCreate.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.success(i18n.t('admin.toast.supplierCreated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const update = trpc.admin.supplierUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.success(i18n.t('admin.toast.supplierUpdated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const remove = trpc.admin.supplierDelete.useMutation({
    onSuccess: () => {
      void utils.admin.supplierList.invalidate();
      toast.info(i18n.t('admin.toast.supplierArchived'));
    },
    onError: errToast('common.error'),
  });

  const closeEditor = useEditorClose(draft, setDraft, create.isPending || update.isPending);

  return (
    <div className="px-4 py-3">
      {canWrite ? null : <ReadOnlyHint />}
      <div className="mb-3 flex items-center gap-2">
        {canWrite ? (
          <Button
            size="sm"
            onClick={() =>
              setDraft({
                name: '',
                contactPhone: '',
                contactTg: '',
                address: '',
                notes: '',
                isArchived: false,
              })
            }
          >
            + {i18n.t('catalog.supplier.newButton')}
          </Button>
        ) : null}
        <div className="ml-auto">
          <Switch
            label={i18n.t('admin.label.showArchived')}
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
        </div>
      </div>
      <DataState
        query={suppliersQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('catalog.supplier.emptyTitle')}
            description={i18n.t('catalog.supplier.emptyBody')}
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((sp) => (
              <Card key={sp.id}>
                <CardHeader>
                  <div className="min-w-0">
                    <CardTitle>{sp.name}</CardTitle>
                    <CardMeta>
                      {sp.contactPhone ? sp.contactPhone : ''}
                      {sp.contactTg ? ` · @${sp.contactTg}` : ''}
                      {sp.address ? ` · ${sp.address}` : ''}
                    </CardMeta>
                  </div>
                  {sp.isArchived ? (
                    <Badge tone="muted">{i18n.t('common.archived')}</Badge>
                  ) : null}
                </CardHeader>
                {canWrite ? (
                  <div className="flex gap-2 border-t border-[var(--c-divider)] px-4 py-2">
                    <Button
                      size="sm"
                      variant="pearl"
                      onClick={() =>
                        setDraft({
                          supplierId: sp.id,
                          name: sp.name,
                          contactPhone: sp.contactPhone ?? '',
                          contactTg: sp.contactTg ?? '',
                          address: sp.address ?? '',
                          notes: sp.notes ?? '',
                          isArchived: sp.isArchived,
                        })
                      }
                    >
                      {i18n.t('common.edit')}
                    </Button>
                    {!sp.isArchived ? (
                      <Button
                        size="sm"
                        variant="danger-ghost"
                        onClick={() =>
                          nativeConfirm(
                            i18n.t('catalog.supplier.confirmArchive', { name: sp.name }),
                            () =>
                            remove.mutate({ supplierId: sp.id }),
                          )
                        }
                      >
                        {i18n.t('common.archive')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="pearl"
                        onClick={() => update.mutate({ supplierId: sp.id, isArchived: false })}
                      >
                        {i18n.t('common.unarchive')}
                      </Button>
                    )}
                  </div>
                ) : null}
              </Card>
            ))}
          </ul>
        )}
      </DataState>

      <Sheet
        open={!!draft}
        onOpenChange={closeEditor}
        title={i18n.t(draft?.supplierId ? 'catalog.supplier.edit' : 'catalog.supplier.new')}
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={!draft?.name.trim()}
            onClick={() => {
              if (!draft) return;
              if (draft.supplierId) {
                update.mutate({
                  supplierId: draft.supplierId,
                  name: draft.name,
                  contactPhone: draft.contactPhone || null,
                  contactTg: draft.contactTg || null,
                  address: draft.address || null,
                  notes: draft.notes || null,
                  isArchived: draft.isArchived,
                });
              } else {
                create.mutate({
                  name: draft.name,
                  contactPhone: draft.contactPhone || null,
                  contactTg: draft.contactTg || null,
                  address: draft.address || null,
                  notes: draft.notes || null,
                });
              }
            }}
          >
            {draft?.supplierId ? i18n.t('common.save') : i18n.t('common.create')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label={`${i18n.t('admin.field.name')} *`}>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={200} autoFocus />
            </Field>
            <Field label={i18n.t('admin.field.phone')}>
              <Input value={draft.contactPhone} onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} maxLength={32} placeholder="+998 …" />
            </Field>
            <Field label={i18n.t('admin.field.tgUsername')}>
              <Input value={draft.contactTg} onChange={(e) => setDraft({ ...draft, contactTg: e.target.value.replace(/^@/, '') })} maxLength={64} placeholder={i18n.t('catalog.supplier.tgPlaceholder')} />
            </Field>
            <Field label={i18n.t('admin.field.address')}>
              <Input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} maxLength={500} />
            </Field>
            <Field label={i18n.t('admin.field.notes')}>
              <Input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} maxLength={1000} />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

// ============ Expense Templates (M3.57) ============
//
// Org-level shortcuts for off-catalog expenses (porter / 装卸费, taxi,
// parking). Admin defines them once; the run page uses them to prefill
// a manual expense form so each business day + store records only the
// costs that actually happened.
//
// CRUD only (no audit timeline, no soft-delete UI niceties — kept
// simple for v1). Mutations require org.admin; reads are open to
// users.manage so store-tier admins can audit the configured list.

interface ExpenseTemplateDraft {
  templateId?: string;
  label: string;
  unitHint: string;
  defaultQty: string;
  defaultUnitPrice: string;
  defaultPaymentMethod: 'cash' | 'transfer';
  sortIndex: number;
  isArchived: boolean;
}

export function ExpenseTemplatesSection() {
  const i18n = useI18n();
  const [includeArchived, setIncludeArchived] = useState(false);
  const templatesQuery = trpc.admin.expenseTemplateList.useQuery({
    includeArchived,
  });
  const utils = trpc.useUtils();
  const toast = useToast();
  const errToast = useErrToast();
  const canWrite = useIsOrgAdmin();
  const [draft, setDraft] = useState<ExpenseTemplateDraft | null>(null);

  const create = trpc.admin.expenseTemplateCreate.useMutation({
    onSuccess: () => {
      void utils.admin.expenseTemplateList.invalidate();
      toast.success(i18n.t('admin.toast.expenseTemplateCreated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const update = trpc.admin.expenseTemplateUpdate.useMutation({
    onSuccess: () => {
      void utils.admin.expenseTemplateList.invalidate();
      toast.success(i18n.t('admin.toast.expenseTemplateUpdated'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const remove = trpc.admin.expenseTemplateDelete.useMutation({
    onSuccess: () => {
      void utils.admin.expenseTemplateList.invalidate();
      toast.info(i18n.t('admin.toast.expenseTemplateArchived'));
    },
    onError: errToast('common.error'),
  });

  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';

  const closeEditor = useEditorClose(draft, setDraft, create.isPending || update.isPending);

  return (
    <div className="px-4 py-3">
      {canWrite ? null : <ReadOnlyHint />}
      <div className="mb-3 flex items-center gap-2">
        {canWrite ? (
          <Button
            size="sm"
            onClick={() =>
              setDraft({
                label: '',
                unitHint: '',
                defaultQty: '1',
                defaultUnitPrice: '',
                defaultPaymentMethod: 'cash',
                sortIndex: 0,
                isArchived: false,
              })
            }
          >
            {i18n.t('admin.action.newExpenseTemplate')}
          </Button>
        ) : null}
        <div className="ml-auto">
          <Switch
            label={i18n.t('admin.label.showArchived')}
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
        </div>
      </div>
      <p className="mb-3 text-old-label text-[var(--c-fg-muted)]">
        {i18n.t('admin.expenseTemplates.intro')}
      </p>
      <DataState
        query={templatesQuery}
        emptyWhen={(d) => d.length === 0}
        empty={
          <EmptyState
            title={i18n.t('admin.expenseTemplates.empty.title')}
            description={i18n.t('admin.expenseTemplates.empty.body')}
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2" role="list">
            {rows.map((tpl) => {
              const lineTotal =
                Number(tpl.defaultQty) * Number(tpl.defaultUnitPrice);
              return (
                <Card key={tpl.id}>
                  <CardHeader>
                    <div className="min-w-0">
                      <CardTitle>{tpl.label}</CardTitle>
                      <CardMeta>
                        {tpl.unitHint ? `${tpl.unitHint} · ` : ''}
                        {/* default qty × unit price, with the
                           payment-method emoji so the manager can
                           scan the list and spot the transfer-only
                           rows at a glance. */}
                        {formatQty(tpl.defaultQty)}{' '}
                        × {formatMoney(tpl.defaultUnitPrice)} {currency}
                        {' = '}
                        <span className="font-semibold text-[var(--c-fg)]">
                          {formatMoney(lineTotal)} {currency}
                        </span>
                        {' · '}
                        {tpl.defaultPaymentMethod === 'transfer'
                          ? `🏦 ${i18n.t('run.label.paymentTransfer')}`
                          : `💵 ${i18n.t('run.label.paymentCash')}`}
                      </CardMeta>
                    </div>
                    {tpl.isArchived ? (
                      <Badge tone="muted">{i18n.t('common.archived')}</Badge>
                    ) : null}
                  </CardHeader>
                  {canWrite ? (
                    <div className="flex gap-2 border-t border-[var(--c-divider)] px-4 py-2">
                      <Button
                        size="sm"
                        variant="pearl"
                        onClick={() =>
                          setDraft({
                            templateId: tpl.id,
                            label: tpl.label,
                            unitHint: tpl.unitHint ?? '',
                            defaultQty: tpl.defaultQty,
                            defaultUnitPrice: tpl.defaultUnitPrice,
                            defaultPaymentMethod: tpl.defaultPaymentMethod as
                              | 'cash'
                              | 'transfer',
                            sortIndex: tpl.sortIndex,
                            isArchived: tpl.isArchived,
                          })
                        }
                      >
                        {i18n.t('admin.action.edit')}
                      </Button>
                      {!tpl.isArchived ? (
                        <Button
                          size="sm"
                          variant="danger-ghost"
                          onClick={() =>
                            nativeConfirm(
                              i18n.t('admin.confirm.archiveExpenseTemplate', {
                                label: tpl.label,
                              }),
                              () => remove.mutate({ templateId: tpl.id }),
                            )
                          }
                        >
                          {i18n.t('admin.action.archive')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="pearl"
                          onClick={() =>
                            update.mutate({
                              templateId: tpl.id,
                              isArchived: false,
                            })
                          }
                        >
                          {i18n.t('admin.action.unarchive')}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </ul>
        )}
      </DataState>

      <Sheet
        open={!!draft}
        onOpenChange={closeEditor}
        title={
          draft?.templateId
            ? i18n.t('admin.sheet.editExpenseTemplate')
            : i18n.t('admin.sheet.newExpenseTemplate')
        }
        footer={
          <Button
            block
            loading={create.isPending || update.isPending}
            disabled={
              !draft?.label.trim() ||
              !draft.defaultQty ||
              Number(draft.defaultQty) <= 0 ||
              !draft.defaultUnitPrice ||
              Number(draft.defaultUnitPrice) <= 0
            }
            onClick={() => {
              if (!draft) return;
              if (draft.templateId) {
                update.mutate({
                  templateId: draft.templateId,
                  label: draft.label.trim(),
                  unitHint: draft.unitHint.trim() || null,
                  defaultQty: draft.defaultQty,
                  defaultUnitPrice: draft.defaultUnitPrice,
                  defaultPaymentMethod: draft.defaultPaymentMethod,
                  sortIndex: draft.sortIndex,
                  isArchived: draft.isArchived,
                });
              } else {
                create.mutate({
                  label: draft.label.trim(),
                  unitHint: draft.unitHint.trim() || null,
                  defaultQty: draft.defaultQty,
                  defaultUnitPrice: draft.defaultUnitPrice,
                  defaultPaymentMethod: draft.defaultPaymentMethod,
                  sortIndex: draft.sortIndex,
                });
              }
            }}
          >
            {i18n.t('common.save')}
          </Button>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
            <Field label={`${i18n.t('admin.field.label')} *`}>
              <Input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                maxLength={200}
                placeholder={i18n.t('admin.expenseTemplates.labelPlaceholder')}
                autoFocus
              />
            </Field>
            <Field label={i18n.t('admin.field.unitHint')}>
              <Input
                value={draft.unitHint}
                onChange={(e) => setDraft({ ...draft, unitHint: e.target.value })}
                maxLength={32}
                placeholder={i18n.t('admin.expenseTemplates.unitHintPlaceholder')}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`${i18n.t('admin.field.defaultQty')} *`}>
                <Input
                  value={draft.defaultQty}
                  onChange={(e) =>
                    setDraft({ ...draft, defaultQty: e.target.value })
                  }
                  inputMode="decimal"
                  placeholder="1"
                />
              </Field>
              <Field label={`${i18n.t('admin.field.defaultUnitPrice')} *`}>
                <Input
                  value={draft.defaultUnitPrice}
                  onChange={(e) =>
                    setDraft({ ...draft, defaultUnitPrice: e.target.value })
                  }
                  inputMode="decimal"
                  placeholder="50000"
                />
              </Field>
            </div>
            <Field label={i18n.t('admin.field.defaultPaymentMethod')}>
              <div className="flex gap-2">
                {(['cash', 'transfer'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() =>
                      setDraft({ ...draft, defaultPaymentMethod: m })
                    }
                    className={
                      'flex-1 rounded-[var(--r-pill)] px-3 py-2 text-old-label font-medium ring-hairline ' +
                      (draft.defaultPaymentMethod === m
                        ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                        : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
                    }
                  >
                    {m === 'cash'
                      ? `💵 ${i18n.t('run.label.paymentCash')}`
                      : `🏦 ${i18n.t('run.label.paymentTransfer')}`}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={i18n.t('admin.field.sortIndex')}>
              <Input
                value={String(draft.sortIndex)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    sortIndex: Number(e.target.value) || 0,
                  })
                }
                inputMode="numeric"
              />
            </Field>
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

// ============ Dishes (M2.0b) ============
//
// Menu items + recipe BOM editor. Lives under Admin → Catalog →
// Dishes. Each dish has:
//
//   - i18n names (4 locales)
//   - optional code (kitchen shorthand like "D-12")
//   - optional unit_price (selling price per serving)
//   - 0+ ingredient rows (sku × qty_per_serving)
//
// The list view is a simple alphabetic grid of dish names with
// current ingredient count. Tap → editor sheet. The editor has
// header fields (name/code/price) and an expandable ingredient
// editor where the operator picks SKUs and types per-serving qty.
//
// Replace-all semantics for ingredients on save (the server diffs
// against current rows to preserve created_at on no-op edits).
//
// Permissions: 'dishes.manage'. Granted by default to manager role
// and to anyone with users.manage.

interface DishDraft {
  dishId?: string; // when editing
  /** CLS-25: the version the editor opened, sent back on save. */
  expectedUpdatedAt?: string;
  code: string;
  names: Record<string, string>;
  description: Record<string, string>;
  unitPrice: string;
  ingredients: Array<{
    skuId: string;
    qtyPerServing: string;
    note: string;
  }>;
}

const EMPTY_DISH: DishDraft = {
  code: '',
  names: {},
  description: {},
  unitPrice: '',
  ingredients: [],
};

export function DishesSection() {
  const i18n = useI18n();
  const productName = useProductName();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const session = useAuthStore((s) => s.session);
  // 2026-10-21 audit CA-16 / E-02: the server (dishes.ts) dropped the
  // `users.manage` fallback; showing editors to managers only bought them
  // a FORBIDDEN on save.
  const canManage = session?.permissions.includes('dishes.manage') ?? false;

  const [includeArchived, setIncludeArchived] = useState(false);
  const dishesQuery = trpc.dishes.list.useQuery({ includeArchived });
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });

  const [draft, setDraft] = useState<DishDraft | null>(null);

  const skuById = useMemo(() => {
    const m = new Map<
      string,
      { id: string; names: Record<string, string>; unit: string; step: string }
    >();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
        step: sku.step,
      });
    }
    return m;
  }, [skusQuery.data]);

  // Group ingredients by dish for quick lookup at render time.
  const ingredientsByDish = useMemo(() => {
    const m = new Map<
      string,
      Array<{ skuId: string; qtyPerServing: string; note: string | null }>
    >();
    for (const row of dishesQuery.data?.ingredients ?? []) {
      const arr = m.get(row.dishId) ?? [];
      arr.push({
        skuId: row.skuId,
        qtyPerServing: row.qtyPerServing,
        note: row.note,
      });
      m.set(row.dishId, arr);
    }
    return m;
  }, [dishesQuery.data?.ingredients]);

  const invalidate = () => {
    void utils.dishes.list.invalidate();
  };
  // 2026-10-21 CA-55: one atomic create-or-update (fields + recipe in
  // one transaction). Was update → setIngredients as two calls, so a
  // failed second call left new fields with the old recipe.
  const save = trpc.dishes.save.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t('common.saved'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const archive = trpc.dishes.archive.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t('common.saved'));
    },
    onError: errToast('common.error'),
  });
  const unarchive = trpc.dishes.unarchive.useMutation({
    onSuccess: invalidate,
    onError: errToast('common.error'),
  });

  const openForEdit = (dishId: string) => {
    const d = (dishesQuery.data?.dishes ?? []).find((x) => x.id === dishId);
    if (!d) return;
    const ing = ingredientsByDish.get(dishId) ?? [];
    setDraft({
      dishId,
      expectedUpdatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : undefined,
      code: d.code ?? '',
      names: d.names as Record<string, string>,
      description: d.description as Record<string, string>,
      unitPrice: d.unitPrice ?? '',
      ingredients: ing.map((i) => ({
        skuId: i.skuId,
        qtyPerServing: i.qtyPerServing,
        note: i.note ?? '',
      })),
    });
  };

  const handleSave = () => {
    if (!draft) return;
    // Strip empty-name locales before sending; an empty string is
    // worse than absence (it would override a fallback later).
    const cleanNames: Record<string, string> = {};
    for (const [k, v] of Object.entries(draft.names)) {
      const t = (v ?? '').trim();
      if (t) cleanNames[k] = t;
    }
    if (Object.keys(cleanNames).length === 0) {
      errToast('common.error')(new Error('dishes.errors.namesRequired'));
      return;
    }
    // CLS-11 (2026-10-30): a row with a product but no amount (or the
    // reverse) was dropped without a word, and amounts / prices were
    // rounded by toFixed. Only a row left completely blank is skipped now;
    // anything half-filled or with too many digits stops the save.
    const filled = draft.ingredients.filter((i) => i.skuId || i.qtyPerServing.trim());
    if (filled.some((i) => !i.skuId || !(Number(i.qtyPerServing) > 0))) {
      errToast('common.error')(new Error('dishes.errors.incompleteIngredient'));
      return;
    }
    if (filled.some((i) => !/^\d{1,8}(\.\d{1,4})?$/.test(i.qtyPerServing.trim()))) {
      errToast('common.error')(new Error('dishes.errors.qtyTooLarge'));
      return;
    }
    const price = draft.unitPrice.trim();
    if (price && !/^\d{1,12}(\.\d{1,2})?$/.test(price)) {
      errToast('common.error')(new Error('dishes.errors.priceTooLarge'));
      return;
    }
    const cleanIngredients = filled.map((i) => ({
      skuId: i.skuId,
      qtyPerServing: i.qtyPerServing.trim(),
      note: i.note.trim() || null,
    }));
    // 2026-10-21 CA-55: the server rejects a SKU listed twice; say so
    // before the round trip.
    if (new Set(cleanIngredients.map((i) => i.skuId)).size !== cleanIngredients.length) {
      errToast('common.error')(new Error('dishes.errors.duplicateIngredient'));
      return;
    }
    save.mutate({
      ...(draft.dishId ? { dishId: draft.dishId } : {}),
      ...(draft.expectedUpdatedAt ? { expectedUpdatedAt: draft.expectedUpdatedAt } : {}),
      code: draft.code.trim() || null,
      names: cleanNames,
      description: draft.description,
      unitPrice: price || null,
      ingredients: cleanIngredients,
    });
  };

  // Helper to add a new empty ingredient row.
  const addIngredient = () => {
    if (!draft) return;
    setDraft({
      ...draft,
      ingredients: [...draft.ingredients, { skuId: '', qtyPerServing: '', note: '' }],
    });
  };

  const closeEditor = useEditorClose(draft, setDraft, save.isPending);

  return (
    <div className="px-4 py-3">
      {/* Top bar: archive toggle + new dish. */}
      <div className="mb-3 flex items-center gap-2">
        {/* M2.1: archive toggle now uses Button (was raw <button>).
            Sat awkwardly next to the proper Button below — same size,
            same shape, but different DOM. Unified to one primitive. */}
        <Button
          variant="pearl"
          size="sm"
          onClick={() => setIncludeArchived((v) => !v)}
        >
          {includeArchived
            ? i18n.t('dishes.action.hideArchived')
            : i18n.t('dishes.action.showArchived')}
        </Button>
        {canManage ? (
          <Button size="sm" onClick={() => setDraft({ ...EMPTY_DISH })} className="ml-auto">
            {i18n.t('dishes.action.new')}
          </Button>
        ) : null}
      </div>

      {/* 2026-10-21 FE-01 / F6-04: a failed dishes.list rendered as "no
          dishes yet". DataState gives loading / error (+Retry) / empty.
          The skus query only feeds ingredient names, so it just extends
          the loading phase as before. */}
      <DataState
        query={{
          data: dishesQuery.data?.dishes,
          isLoading: dishesQuery.isLoading || skusQuery.isLoading,
          isError: dishesQuery.isError,
          isFetching: dishesQuery.isFetching,
          error: dishesQuery.error,
          refetch: () => void dishesQuery.refetch(),
        }}
        emptyWhen={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title={i18n.t('dishes.empty.title')}
            description={i18n.t('dishes.empty.description')}
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-1" role="list">
            {rows.map((d) => {
              const name = productName({ names: d.names as Record<string, string> });
              const ingCount = (ingredientsByDish.get(d.id) ?? []).length;
              return (
                <li
                  key={d.id}
                  className={
                    'rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-3 py-2 ring-hairline ' +
                    (d.isArchived ? 'opacity-60' : '')
                  }
                >
                  <button
                    type="button"
                    onClick={() => openForEdit(d.id)}
                    className="flex w-full items-baseline justify-between gap-2 text-left active:opacity-80"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-old-body font-semibold">{name}</span>
                        {d.code ? (
                          <span className="text-old-label text-[var(--c-fg-muted)]">{d.code}</span>
                        ) : null}
                        {d.isArchived ? (
                          <Badge tone="muted">{i18n.t('common.archived')}</Badge>
                        ) : null}
                      </div>
                      <div className="text-old-label text-[var(--c-fg-muted)]">
                        {ingCount === 0
                          ? i18n.t('dishes.label.noIngredients')
                          : i18n.t('dishes.label.ingredientCount', { n: ingCount })}
                        {d.unitPrice ? ` · ${formatMoney(d.unitPrice)}` : ''}
                      </div>
                    </div>
                  </button>
                  {/* M3.17 (2026-05-16): inline archive/unarchive pills →
                    Button size="sm". Archive uses danger-ghost (consistent
                    with the Category / SKU / Supplier archive rows). */}
                  {canManage ? (
                    <div className="mt-1 flex gap-2">
                      {d.isArchived ? (
                        <Button
                          size="sm"
                          variant="pearl"
                          onClick={() => unarchive.mutate({ dishId: d.id })}
                        >
                          {i18n.t('common.unarchive')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger-ghost"
                          onClick={() =>
                            nativeConfirm(i18n.t('dishes.confirm.archive', { name }), () =>
                              archive.mutate({ dishId: d.id }),
                            )
                          }
                        >
                          {i18n.t('common.archive')}
                        </Button>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      {/* Editor sheet. */}
      <Sheet
        open={draft !== null}
        onOpenChange={closeEditor}
        title={
          draft?.dishId
            ? i18n.t('dishes.sheet.editTitle')
            : i18n.t('dishes.sheet.newTitle')
        }
        footer={
          // 2026-07-30: was `!getTg() && draft`, i.e. "only outside
          // Telegram, because inside it the native MainButton is the CTA".
          // Two things were wrong with that. `getTg()` is truthy in ANY
          // browser — index.html loads telegram-web-app.js statically — so
          // the footer never rendered anywhere. And nothing has driven the
          // native MainButton for this sheet since M3.49 retired it in
          // favour of the in-DOM PageMainButton, which this page doesn't
          // register either. Net result: creating or editing a dish was
          // impossible, in every environment. Verified in the browser —
          // the sheet's only button was "+ 添加食材".
          //
          // M3.49 already made exactly this fix for ConfirmPage's issue
          // sheet and RunSheets' confirm sheet ("Was `!inTelegram` … no
          // longer correct"); these two admin sheets were missed.
          // CLS-13 (2026-10-30): without dishes.manage the sheet is a
          // read-only view; Save used to be offered and then refused.
          draft && canManage ? (
            <Button
              block
              loading={save.isPending}
              onClick={handleSave}
            >
              {i18n.t('common.save')}
            </Button>
          ) : null
        }
      >
        {draft ? (
          <fieldset disabled={!canManage} className="flex min-w-0 flex-col gap-3 border-0 p-0 py-3">
            {!canManage ? <Banner tone="info" title={i18n.t('dishes.readOnly')} /> : null}
            {/* Names — 4 locales. */}
            {(['en', 'zh', 'ru', 'uz'] as const).map((loc) => (
              <Field key={loc} label={`${i18n.t('common.name')} · ${loc.toUpperCase()}`}>
                <Input
                  value={draft.names[loc] ?? ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      names: { ...draft.names, [loc]: e.target.value },
                    })
                  }
                  placeholder={loc === 'en' ? 'e.g. Beef plov' : ''}
                />
              </Field>
            ))}
            <Field label={i18n.t('dishes.field.code')} hint={i18n.t('dishes.field.codeHint')}>
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder="D-12"
              />
            </Field>
            <Field label={i18n.t('dishes.field.unitPrice')}>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={draft.unitPrice}
                onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })}
              />
            </Field>

            {/* Ingredients. M2.1: SectionLabel + add-ingredient
                button uses Button component. */}
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-2 px-0">
                <SectionLabel className="px-0 py-0">
                  {i18n.t('dishes.section.ingredients')}
                </SectionLabel>
                <Button variant="pearl" size="sm" onClick={addIngredient}>
                  {i18n.t('dishes.action.addIngredient')}
                </Button>
              </div>
              {draft.ingredients.length === 0 ? (
                <p className="text-old-label text-[var(--c-fg-muted)]">
                  {i18n.t('dishes.label.noIngredientsHint')}
                </p>
              ) : (
                <ul className="flex flex-col gap-2" role="list">
                  {draft.ingredients.map((ing, idx) => {
                    const sku = skuById.get(ing.skuId);
                    return (
                      <li
                        key={idx}
                        className="flex flex-col gap-1 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline"
                      >
                        <div className="flex items-center gap-2">
                          <select
                            className="h-9 min-w-0 flex-1 rounded-[var(--r-pill)] bg-[var(--c-surface)] px-3 text-old-body ring-hairline"
                            value={ing.skuId}
                            onChange={(e) => {
                              const next = [...draft.ingredients];
                              next[idx] = { ...next[idx]!, skuId: e.target.value };
                              setDraft({ ...draft, ingredients: next });
                            }}
                          >
                            <option value="">{i18n.t('dishes.field.pickSku')}</option>
                            {(skusQuery.data ?? []).map((skuRow) => (
                              <option key={skuRow.id} value={skuRow.id}>
                                {productName({ names: skuRow.names as Record<string, string> })}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => {
                              const next = draft.ingredients.filter((_, i) => i !== idx);
                              setDraft({ ...draft, ingredients: next });
                            }}
                            aria-label={i18n.t('common.remove')}
                            className="press shrink-0 rounded-[var(--r-pill)] bg-[var(--c-surface)] px-2 py-0.5 text-old-label text-[var(--c-danger)] ring-hairline"
                          >
                            ×
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            inputMode="decimal"
                            step={sku?.step ?? '0.001'}
                            min="0"
                            value={ing.qtyPerServing}
                            onChange={(e) => {
                              const next = [...draft.ingredients];
                              next[idx] = { ...next[idx]!, qtyPerServing: e.target.value };
                              setDraft({ ...draft, ingredients: next });
                            }}
                            placeholder={i18n.t('dishes.field.qtyPlaceholder')}
                          />
                          <span className="text-old-label text-[var(--c-fg-muted)]">
                            {sku?.unit ?? '—'}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </fieldset>
        ) : null}
      </Sheet>
    </div>
  );
}

