/**
 * Admin → Catalog → Dishes: menu items and their recipes. Review ADM2-11
 * (2026-11-11): one file per catalog section.
 */
import { useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  DataState,
  EmptyState,
  Field,
  FieldError,
  Input,
  NameCell,
  SectionLabel,
  Select,
  Sheet,
  useToast,
  rowGroupClass,
} from '@compass/ui';
import { CATALOG_TEXT_MAX } from '@compass/contracts/limits';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../hooks/useErrToast';
import { formatMoney } from '../../../lib/format';
import { useI18n, useProductName, useProductNameParts, useUnitLabel } from '../../../hooks/useI18n';
import { CatalogNameFields, CatalogToolbar, useArchivedToast } from './CatalogParts';
import { EMPTY_NAMES, namesForEdit, type CatalogNames } from './catalogNames';
import { checkDishDraft, type DishIngredientDraft } from './dishDraft';
import { haptic } from '../../../lib/telegram';
import { useEditorSheet } from '../../../hooks/useDraftChanged';

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
  names: CatalogNames;
  description: Record<string, string>;
  unitPrice: string;
  ingredients: DishIngredientDraft[];
}

/**
 * Review ADM2-43 (2026-11-11): an ingredient row is keyed by an id of its
 * own. Keyed by position, removing a middle row handed the next row's
 * fields (and its "archived" note id) to the removed one's components.
 */
let ingredientKeySeq = 0;
const newIngredientKey = () => `ing-${++ingredientKeySeq}`;

const EMPTY_DISH: DishDraft = {
  code: '',
  names: EMPTY_NAMES,
  description: {},
  unitPrice: '',
  ingredients: [],
};

export function DishesSection() {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const productName = useProductName();
  const productNameParts = useProductNameParts();
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
  // DX-DSH-1 (2026-11-01): archived products too, so a recipe row whose
  // product was taken off the catalog shows its name marked "archived"
  // instead of an empty "pick an ingredient"; the picker offers active
  // ones only.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });

  const [draft, setDraft] = useState<DishDraft | null>(null);

  const skuById = useMemo(() => {
    const m = new Map<
      string,
      {
        id: string;
        names: Record<string, string>;
        unit: string;
        step: string;
        isArchived: boolean;
      }
    >();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names,
        unit: sku.unit,
        step: sku.step,
        isArchived: sku.isArchived,
      });
    }
    return m;
  }, [skusQuery.data]);
  const activeSkus = useMemo(
    () => (skusQuery.data ?? []).filter((sku) => !sku.isArchived),
    [skusQuery.data],
  );

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
    onError: errToast('common.errors.actionFailed'),
  });
  const unarchive = trpc.dishes.unarchive.useMutation({
    onSuccess: invalidate,
    onError: errToast('common.errors.actionFailed'),
  });
  // D3 (2026-11-13): archiving no longer asks first; the toast's Undo
  // and the row's Unarchive take it back.
  const archivedToast = useArchivedToast();
  const archive = trpc.dishes.archive.useMutation({
    onSuccess: (_data, vars) => {
      invalidate();
      archivedToast(i18n.t('dishes.toast.archived'), () =>
        unarchive.mutate({ dishId: vars.dishId }),
      );
    },
    onError: errToast('common.errors.actionFailed'),
  });

  const openForEdit = (dishId: string) => {
    const d = (dishesQuery.data?.dishes ?? []).find((x) => x.id === dishId);
    if (!d) return;
    const ing = ingredientsByDish.get(dishId) ?? [];
    setDraft({
      dishId,
      expectedUpdatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : undefined,
      code: d.code ?? '',
      names: namesForEdit(d.names),
      description: d.description,
      unitPrice: d.unitPrice ?? '',
      ingredients: ing.map((i) => ({
        key: newIngredientKey(),
        skuId: i.skuId,
        qtyPerServing: i.qtyPerServing,
        note: i.note ?? '',
      })),
    });
  };

  const handleSave = () => {
    if (!draft) return;
    const check = checkDishDraft(draft, (skuId) => skuById.get(skuId)?.isArchived ?? false);
    if (!check.ok) {
      haptic('error');
      toast.error(i18n.t(check.problem));
      return;
    }
    save.mutate({
      ...(draft.dishId ? { dishId: draft.dishId } : {}),
      ...(draft.expectedUpdatedAt ? { expectedUpdatedAt: draft.expectedUpdatedAt } : {}),
      code: draft.code.trim() || null,
      names: check.names,
      description: draft.description,
      unitPrice: check.unitPrice,
      ingredients: check.ingredients,
    });
  };

  // Helper to add a new empty ingredient row.
  const addIngredient = () => {
    if (!draft) return;
    setDraft({
      ...draft,
      ingredients: [
        ...draft.ingredients,
        { key: newIngredientKey(), skuId: '', qtyPerServing: '', note: '' },
      ],
    });
  };

  const editor = useEditorSheet(draft, setDraft, (d) => d.dishId ?? 'new', save.isPending);

  return (
    <div className="px-4 py-3">
      {/* Top bar: new dish + archive switch. Wraps like the other catalog
          bars (ADM2-13). Review ADM2-33 (2026-11-11): the archive toggle is
          the Switch the product, supplier and expense lists use, in the
          same place (it was a button that changed its own words). */}
      <CatalogToolbar
        newLabel={canManage ? i18n.t('dishes.action.new') : undefined}
        onNew={() => setDraft({ ...EMPTY_DISH })}
        showArchived={includeArchived}
        onShowArchivedChange={setIncludeArchived}
      />

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
            // DX-DSH-2 (2026-11-01): "add menu items here" to someone who
            // has no New button and can't add any.
            description={i18n.t(
              canManage ? 'dishes.empty.description' : 'dishes.empty.readOnlyDescription',
            )}
          />
        }
      >
        {(rows) => (
          <ul className={rowGroupClass} role="list">
            {rows.map((d) => {
              const names = d.names;
              const ingCount = (ingredientsByDish.get(d.id) ?? []).length;
              return (
                <li key={d.id} className={'px-4 py-3 ' + (d.isArchived ? 'opacity-60' : '')}>
                  <button
                    type="button"
                    onClick={() => openForEdit(d.id)}
                    className="flex w-full items-baseline justify-between gap-2 text-left active:opacity-80"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <NameCell as="span" {...productNameParts({ names })} />
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
                          loading={unarchive.isPending && unarchive.variables?.dishId === d.id}
                          onClick={() => unarchive.mutate({ dishId: d.id })}
                        >
                          {i18n.t('common.unarchive')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger-ghost"
                          onClick={() => archive.mutate({ dishId: d.id })}
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
        {...editor}
        title={draft?.dishId ? i18n.t('dishes.sheet.editTitle') : i18n.t('dishes.sheet.newTitle')}
        footer={
          // Save is the sheet's own button, in Telegram and in a browser
          // alike (2026-07-30). CLS-13 (2026-10-30): without dishes.manage
          // the sheet is a read-only view; Save used to be offered and then
          // refused.
          draft && canManage ? (
            <Button block loading={save.isPending} onClick={handleSave}>
              {i18n.t('common.save')}
            </Button>
          ) : null
        }
      >
        {draft ? (
          <fieldset disabled={!canManage} className="flex min-w-0 flex-col gap-3 border-0 p-0 py-3">
            {!canManage ? <Banner tone="info" title={i18n.t('dishes.readOnly')} /> : null}
            {/* Walkthrough F16 (2026-11-05): the same name fields as the
                category and product forms. ADM2-11: the same component. */}
            <CatalogNameFields
              names={draft.names}
              onChange={(names) => setDraft({ ...draft, names })}
            />
            <Field label={i18n.t('dishes.field.code')} hint={i18n.t('dishes.field.codeHint')}>
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                maxLength={CATALOG_TEXT_MAX.dishCode}
                placeholder="D-12"
              />
            </Field>
            <Field label={i18n.t('dishes.field.unitPrice')}>
              <Input
                type="number"
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
                // Review ADM2-12 (2026-11-11): rows of one white card, not
                // grey cards (UI-6, UI-13).
                <ul className={rowGroupClass} role="list">
                  {draft.ingredients.map((ing, idx) => {
                    const sku = skuById.get(ing.skuId);
                    const archivedSku = sku?.isArchived ? sku : null;
                    const archivedNoteId = `dish-${ing.key}-archived`;
                    return (
                      <li key={ing.key} className="flex flex-col gap-1 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          {/* DX-VIS-5: the kit Select (field edge at 3:1);
                              an archived product is marked by its danger ring. */}
                          <div className="min-w-0 flex-1">
                            <Select
                              value={ing.skuId}
                              aria-label={i18n.t('dishes.field.pickSku')}
                              invalid={!!archivedSku}
                              aria-describedby={archivedSku ? archivedNoteId : undefined}
                              onChange={(e) => {
                                const next = [...draft.ingredients];
                                next[idx] = { ...next[idx]!, skuId: e.target.value };
                                setDraft({ ...draft, ingredients: next });
                              }}
                            >
                              <option value="">{i18n.t('dishes.field.pickSku')}</option>
                              {archivedSku ? (
                                <option value={archivedSku.id} disabled>
                                  {i18n.t('dishes.label.archivedSku', {
                                    name: productName({ names: archivedSku.names }),
                                  })}
                                </option>
                              ) : null}
                              {activeSkus.map((skuRow) => (
                                <option key={skuRow.id} value={skuRow.id}>
                                  {productName({ names: skuRow.names })}
                                </option>
                              ))}
                            </Select>
                          </div>
                          <Button
                            size="sm"
                            variant="danger-ghost"
                            onClick={() => {
                              const next = draft.ingredients.filter((_, i) => i !== idx);
                              setDraft({ ...draft, ingredients: next });
                            }}
                            aria-label={i18n.t('common.remove')}
                            className="shrink-0"
                          >
                            ×
                          </Button>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            value={ing.qtyPerServing}
                            onChange={(e) => {
                              const next = [...draft.ingredients];
                              next[idx] = { ...next[idx]!, qtyPerServing: e.target.value };
                              setDraft({ ...draft, ingredients: next });
                            }}
                            placeholder={i18n.t('dishes.field.qtyPlaceholder')}
                          />
                          <span className="text-old-label text-[var(--c-fg-muted)]">
                            {sku?.unit ? unitLabel.uncounted(sku.unit) : '—'}
                          </span>
                        </div>
                        {archivedSku ? (
                          <FieldError id={archivedNoteId} className="mt-0">
                            {i18n.t('dishes.errors.archivedIngredientRow')}
                          </FieldError>
                        ) : null}
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
