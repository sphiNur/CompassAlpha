import { useMemo, useState } from 'react';
import { useToast } from '@compass/ui';
import { Button, cn, Field, Sheet } from '@compass/ui/kit';
import { SKU_STEPS, SKU_UNITS } from '@compass/contracts';
import type { SkuStep, SkuUnit } from '@compass/contracts';
import { trpc } from '../../lib/trpc';
import { useErrToast } from '../../lib/errToast';
import { confirmThen } from '../../lib/confirm';
import { matchesNameLike, normalizeQuery } from '../../lib/searchMatch';
import { useI18n, useProductName, useUnitLabel } from '../../hooks/useI18n';
import { ChevronIcon, ClockIcon, PlusIcon, SearchIcon } from '../icons';

const LANGS = [
  { key: 'uz', label: "O'zbekcha", example: 'Pomidor' },
  { key: 'ru', label: 'Русский', example: 'Помидор' },
  { key: 'en', label: 'English', example: 'Tomato' },
  { key: 'zh', label: '中文', example: '西红柿' },
] as const;
type Lang = (typeof LANGS)[number]['key'];

interface Draft {
  skuId?: string;
  archived: boolean;
  categoryId: string | null;
  code: string;
  names: Record<Lang, string>;
  unit: SkuUnit;
  step: SkuStep;
  sortIndex: number;
}

const CAPSULE =
  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70';
const pick = (on: boolean) =>
  cn(CAPSULE, on ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink');

// Units and steps are fixed lists on the server. A product saved before
// they were is shown on the nearest one, so the editor always opens on a
// value that can be saved back.
function unitOf(unit: string): SkuUnit {
  if ((SKU_UNITS as readonly string[]).includes(unit)) return unit as SkuUnit;
  if (unit === 'g') return 'kg';
  if (unit === 'karobka') return 'box';
  if (unit === 'boglima') return 'bunch';
  return 'pcs';
}
function stepOf(step: string): SkuStep {
  if ((SKU_STEPS as readonly string[]).includes(step)) return step as SkuStep;
  const n = Number(step);
  if (!Number.isFinite(n)) return '1';
  // Never up to a bulk step nobody chose.
  return n <= 0.5 ? '0.5' : '1';
}

/**
 * The catalogue: what stores can order.
 *
 * Laid out like the ordering screen it feeds: a search capsule, the
 * categories as a strip of capsules, products as rows under their
 * category. A row opens the product; editing and archiving are in
 * there, not as two buttons on every row.
 *
 * A product has a name in each of four languages and the server wants
 * all four. Here one is enough: the ones left empty are saved with the
 * same name, to be translated when someone can.
 */
export function ProductsScreen() {
  const i18n = useI18n();
  const productName = useProductName();
  const unitLabel = useUnitLabel();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();

  const [archivedToo, setArchivedToo] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [more, setMore] = useState(false);

  const skus = trpc.admin.skuList.useQuery({ includeArchived: archivedToo });
  const categories = trpc.admin.categoryList.useQuery();
  const done = (message: string) => () => {
    void utils.admin.skuList.invalidate();
    void utils.catalog.skus.invalidate();
    toast.success(message);
    setDraft(null);
  };
  const create = trpc.admin.skuCreate.useMutation({
    onSuccess: done(i18n.t('admin.toast.skuCreated') as string),
    onError: errToast('common.error'),
  });
  const update = trpc.admin.skuUpdate.useMutation({
    onSuccess: done(i18n.t('admin.toast.skuUpdated') as string),
    onError: errToast('common.error'),
  });
  const archive = trpc.admin.skuDelete.useMutation({
    onSuccess: done(i18n.t('admin.toast.skuArchived') as string),
    onError: errToast('common.error'),
  });

  const cats = useMemo(() => categories.data ?? [], [categories.data]);
  const categoryName = (id: string | null): string => {
    const c = id ? cats.find((x) => x.id === id) : undefined;
    return c
      ? productName({ names: c.names as Record<string, string> }) || c.slug
      : (i18n.t('run.view.uncategorized') as string);
  };

  const tokens = normalizeQuery(typed);
  const rows = (skus.data ?? []).filter(
    (sku) =>
      (!category || sku.categoryId === category) &&
      (!tokens ||
        matchesNameLike(
          { names: sku.names as Record<string, string> | null, code: sku.code },
          tokens,
        )),
  );
  // Under a heading per category, unless the list has been narrowed.
  const groups: Array<{ id: string | null; rows: typeof rows }> = [];
  if (tokens || category) {
    groups.push({ id: category, rows });
  } else {
    const known = new Set(cats.map((c) => c.id));
    for (const c of cats) {
      const mine = rows.filter((sku) => sku.categoryId === c.id);
      if (mine.length > 0) groups.push({ id: c.id, rows: mine });
    }
    const rest = rows.filter((sku) => !sku.categoryId || !known.has(sku.categoryId));
    if (rest.length > 0) groups.push({ id: null, rows: rest });
  }

  const blank = (): Draft => ({
    archived: false,
    categoryId: category,
    code: '',
    names: { uz: '', ru: '', en: '', zh: '' },
    unit: 'pcs',
    step: '1',
    sortIndex: 100,
  });
  const open = (next: Draft) => {
    setMore(false);
    setDraft(next);
  };

  const filled = draft ? LANGS.map((l) => draft.names[l.key].trim()).filter(Boolean) : [];
  const save = () => {
    if (!draft || filled.length === 0) return;
    // The name in the language being used, else the first one given.
    const fallback = draft.names[i18n.locale as Lang]?.trim() || filled[0]!;
    const names = Object.fromEntries(
      LANGS.map((l) => [l.key, draft.names[l.key].trim() || fallback]),
    ) as Record<Lang, string>;
    const body = {
      categoryId: draft.categoryId,
      code: draft.code.trim() || null,
      names,
      unit: draft.unit,
      step: draft.step,
      sortIndex: draft.sortIndex,
    };
    if (draft.skuId) update.mutate({ skuId: draft.skuId, ...body });
    else create.mutate(body);
  };
  const busy = create.isPending || update.isPending || archive.isPending;

  return (
    <div className="flex flex-col gap-xl px-page">
      <button
        type="button"
        data-testid="product-new"
        onClick={() => open(blank())}
        className="flex items-center gap-lg rounded-lg border border-dashed border-line p-xl text-start outline-none active:opacity-60"
      >
        <span
          aria-hidden
          className="flex size-avatar shrink-0 items-center justify-center rounded-pill bg-primary text-on-primary"
        >
          <PlusIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-label text-ink">{i18n.t('catalog.sku.new')}</span>
          <span className="block text-small text-secondary">
            {i18n.t('admin.empty.noSkus.description')}
          </span>
        </span>
        <span className="shrink-0 text-forest">
          <ChevronIcon />
        </span>
      </button>

      <div className="flex flex-col gap-lg">
        <label className="flex h-control items-center gap-md rounded-pill bg-field px-lg text-secondary ring-1 ring-inset ring-secondary focus-within:ring-2 focus-within:ring-ink">
          <SearchIcon />
          <input
            type="search"
            aria-label={i18n.t('admin.search.skusPlaceholder') as string}
            placeholder={i18n.t('admin.search.skusPlaceholder') as string}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-secondary"
          />
        </label>
        <div className="-mx-page flex gap-sm overflow-x-auto px-page">
          {[null, ...cats.map((c) => c.id)].map((id) => (
            <button
              key={id ?? 'all'}
              type="button"
              aria-pressed={category === id}
              data-testid="product-category"
              onClick={() => setCategory(id)}
              className={pick(category === id)}
            >
              {id ? categoryName(id) : i18n.t('order.categories.all')}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={archivedToo}
            data-testid="product-archived"
            onClick={() => setArchivedToo(!archivedToo)}
            className={pick(archivedToo)}
          >
            {i18n.t('admin.label.showArchived')}
          </button>
        </div>
      </div>

      {skus.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : skus.isError ? (
        <div className="flex flex-col items-start gap-md">
          <p className="text-body text-danger">{i18n.t('common.error')}</p>
          <Button inline onClick={() => void skus.refetch()}>
            {i18n.t('common.retry')}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-lg">
          <span
            aria-hidden
            className="flex size-avatar shrink-0 items-center justify-center rounded-pill border border-line text-secondary"
          >
            <ClockIcon />
          </span>
          <span className="text-label text-secondary">
            {tokens || category
              ? i18n.t('admin.search.noMatches.title')
              : i18n.t('admin.empty.noSkus.title')}
          </span>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.id ?? 'rest'} className="flex flex-col gap-sm">
            {tokens || category ? null : (
              <h2 className="text-body text-secondary">{categoryName(group.id)}</h2>
            )}
            <ul className="flex flex-col">
              {group.rows.map((sku) => {
                const names = sku.names as Record<string, string>;
                const name = productName({ names }) || sku.code || sku.id.slice(0, 6);
                return (
                  <li key={sku.id}>
                    <button
                      type="button"
                      data-testid="product-row"
                      onClick={() =>
                        open({
                          skuId: sku.id,
                          archived: sku.isArchived,
                          categoryId: sku.categoryId,
                          code: sku.code ?? '',
                          names: {
                            uz: names.uz ?? '',
                            ru: names.ru ?? '',
                            en: names.en ?? '',
                            zh: names.zh ?? '',
                          },
                          unit: unitOf(sku.unit),
                          step: stepOf(sku.step),
                          sortIndex: sku.sortIndex,
                        })
                      }
                      className="flex min-h-row w-full items-center gap-lg py-sm text-start outline-none active:opacity-60"
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block text-label',
                            sku.isArchived ? 'text-secondary line-through' : 'text-ink',
                          )}
                        >
                          {name}
                        </span>
                        <span className="block text-small text-secondary">
                          {[
                            unitLabel(sku.unit),
                            i18n.t('products.stepEach', { step: Number(sku.step) }),
                            sku.isArchived ? i18n.t('products.archived') : null,
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
          </section>
        ))
      )}

      <Sheet
        open={!!draft}
        onOpenChange={(next) => !next && !busy && setDraft(null)}
        title={i18n.t(draft?.skuId ? 'catalog.sku.edit' : 'catalog.sku.new') as string}
        actions={
          draft ? (
            <>
              <Button
                variant="primary"
                data-testid="product-save"
                busy={create.isPending || update.isPending}
                disabled={filled.length === 0 || archive.isPending}
                onClick={save}
              >
                {draft.skuId ? i18n.t('common.save') : i18n.t('common.create')}
              </Button>
              {draft.skuId && !draft.archived ? (
                <Button
                  variant="ghost"
                  data-testid="product-archive"
                  disabled={busy}
                  onClick={() =>
                    confirmThen(
                      i18n.t('catalog.sku.confirmArchive', {
                        name: filled[0] ?? '',
                      }) as string,
                      () => archive.mutate({ skuId: draft.skuId! }),
                    )
                  }
                >
                  <span className="text-danger">{i18n.t('common.archive')}</span>
                </Button>
              ) : null}
              {draft.skuId && draft.archived ? (
                <Button
                  variant="secondary"
                  data-testid="product-unarchive"
                  disabled={busy}
                  onClick={() => update.mutate({ skuId: draft.skuId!, isArchived: false })}
                >
                  {i18n.t('common.unarchive')}
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

            <div className="flex flex-col gap-sm">
              <span className="text-label text-ink">{i18n.t('admin.field.category')}</span>
              <div className="flex flex-wrap gap-sm">
                {[null, ...cats.map((c) => c.id)].map((id) => (
                  <button
                    key={id ?? 'none'}
                    type="button"
                    aria-pressed={draft.categoryId === id}
                    onClick={() => setDraft({ ...draft, categoryId: id })}
                    className={pick(draft.categoryId === id)}
                  >
                    {categoryName(id)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-sm">
              <span className="text-label text-ink">{i18n.t('admin.field.unit')}</span>
              <div className="flex flex-wrap gap-sm">
                {SKU_UNITS.map((unit) => (
                  <button
                    key={unit}
                    type="button"
                    aria-pressed={draft.unit === unit}
                    data-testid="product-unit"
                    onClick={() => setDraft({ ...draft, unit })}
                    className={pick(draft.unit === unit)}
                  >
                    {unitLabel(unit)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-sm">
              <span className="text-label text-ink">{i18n.t('admin.field.step')}</span>
              <div className="flex flex-wrap gap-sm">
                {SKU_STEPS.map((step) => (
                  <button
                    key={step}
                    type="button"
                    aria-pressed={draft.step === step}
                    onClick={() => setDraft({ ...draft, step })}
                    className={pick(draft.step === step)}
                  >
                    <span dir="ltr">{step}</span>
                  </button>
                ))}
              </div>
              <p className="text-small text-secondary">{i18n.t('products.stepHint')}</p>
            </div>

            {more ? (
              <div className="flex flex-col gap-md">
                <Field
                  label={i18n.t('admin.field.code') as string}
                  value={draft.code}
                  maxLength={64}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                />
                <Field
                  numeric
                  label={i18n.t('admin.field.sortIndex') as string}
                  value={String(draft.sortIndex)}
                  onChange={(e) => setDraft({ ...draft, sortIndex: Number(e.target.value) || 0 })}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setMore(true)}
                className={cn(CAPSULE, 'self-start bg-surface-sunken text-ink')}
              >
                {i18n.t('products.more')}
              </button>
            )}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
