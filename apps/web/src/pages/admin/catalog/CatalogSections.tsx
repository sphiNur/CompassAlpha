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
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  SectionLabel,
  Sheet,
  Spinner,
  useToast,
} from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { formatMoney } from '../../../lib/format';
import { useI18n, useProductName } from '../../../hooks/useI18n';
import { nativeConfirm } from '../shared';

interface DishDraft {
  dishId?: string; // when editing
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
  const canManage =
    (session?.permissions.includes('dishes.manage') ?? false) ||
    (session?.permissions.includes('users.manage') ?? false);

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
  const create = trpc.dishes.create.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(i18n.t('common.saved'));
      setDraft(null);
    },
    onError: errToast('common.error'),
  });
  const update = trpc.dishes.update.useMutation({
    onSuccess: invalidate,
    onError: errToast('common.error'),
  });
  const setIngredients = trpc.dishes.setIngredients.useMutation({
    onSuccess: invalidate,
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
    const cleanIngredients = draft.ingredients
      .filter((i) => i.skuId && Number(i.qtyPerServing) > 0)
      .map((i) => ({
        skuId: i.skuId,
        qtyPerServing: Number(i.qtyPerServing).toFixed(4),
        note: i.note.trim() || null,
      }));
    const payload = {
      code: draft.code.trim() || null,
      names: cleanNames,
      description: draft.description,
      unitPrice: draft.unitPrice.trim() ? Number(draft.unitPrice).toFixed(2) : null,
    };
    if (draft.dishId) {
      // Update happens in two calls because the routes are split.
      // Acceptable since both are inside one transaction at the DB.
      update.mutate(
        { dishId: draft.dishId, ...payload },
        {
          onSuccess: () => {
            setIngredients.mutate(
              { dishId: draft.dishId!, ingredients: cleanIngredients },
              {
                onSuccess: () => {
                  toast.success(i18n.t('common.saved'));
                  setDraft(null);
                },
              },
            );
          },
        },
      );
    } else {
      create.mutate({ ...payload, ingredients: cleanIngredients });
    }
  };

  // Helper to add a new empty ingredient row.
  const addIngredient = () => {
    if (!draft) return;
    setDraft({
      ...draft,
      ingredients: [...draft.ingredients, { skuId: '', qtyPerServing: '', note: '' }],
    });
  };

  const dishes = dishesQuery.data?.dishes ?? [];

  return (
    <div className="px-4 py-3">
      {/* Top bar: archive toggle + new dish. */}
      <div className="mb-3 flex items-center gap-2">
        {/* M2.1: archive toggle now uses Button (was raw <button>).
            Sat awkwardly next to the proper Button below — same size,
            same shape, but different DOM. Unified to one primitive. */}
        <Button variant="pearl" size="sm" onClick={() => setIncludeArchived((v) => !v)}>
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

      {dishesQuery.isLoading || skusQuery.isLoading ? (
        <div className="py-6 text-center">
          <Spinner size={16} />
        </div>
      ) : dishes.length === 0 ? (
        <EmptyState
          title={i18n.t('dishes.empty.title')}
          description={i18n.t('dishes.empty.description')}
        />
      ) : (
        <ul className="flex flex-col gap-1" role="list">
          {dishes.map((d) => {
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

      {/* Editor sheet. */}
      <Sheet
        open={draft !== null}
        onOpenChange={(open) => !open && setDraft(null)}
        title={draft?.dishId ? i18n.t('dishes.sheet.editTitle') : i18n.t('dishes.sheet.newTitle')}
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
          draft ? (
            <Button
              block
              loading={create.isPending || update.isPending || setIngredients.isPending}
              onClick={handleSave}
            >
              {i18n.t('common.save')}
            </Button>
          ) : null
        }
      >
        {draft ? (
          <div className="flex flex-col gap-3 py-3">
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
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
