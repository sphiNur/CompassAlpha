/**
 * Count mode (D1, 2026-11-13): count a whole store on one screen.
 *
 * Counting used to be one product per sheet: Stocktake on a row, type,
 * Save, and again for the next product. Here every product of the store
 * is a row with its on-hand and a number field; the keyboard's next key
 * moves down the list, a row left empty is not counted, and one Save
 * records every count after a summary ("12 products counted, 3 differ
 * from stock"). The one-product sheet stays for a single correction.
 *
 * Saving uses inventory.stocktakeBatch, which applies each count exactly
 * as inventory.stocktake does, in one transaction. Like the other stock
 * writes it is a direct mutation, not an outbox write: offline, Save
 * fails with the usual message and the typed counts stay. Each part sent
 * keeps its idempotency key while its content is the same, so a retry
 * after a lost answer replays instead of counting again.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Button,
  cn,
  EmptyState,
  FieldError,
  Input,
  isCommitEnter,
  LoadingState,
  NameCell,
  QueryErrorBanner,
  rowGroupClass,
  SearchInput,
  SectionLabel,
  Sheet,
  useToast,
} from '@compass/ui';
import { STOCKTAKE_BATCH_MAX, STOCKTAKE_COUNT_MESSAGE } from '@compass/contracts/limits';
import { newIdempotencyKey, trpc } from '../../../../lib/trpc';
import { useErrToast } from '../../../../hooks/useErrToast';
import { formatQty } from '../../../../lib/format';
import { haptic } from '../../../../lib/telegram';
import { normalizeQuery, rankNameLike } from '../../../../lib/searchMatch';
import { rowName } from '../../../../lib/productName';
import {
  useI18n,
  useProductName,
  useProductNameParts,
  useUnitLabel,
} from '../../../../hooks/useI18n';
import { groupCatalog } from '../../../order/catalogGroups';
import {
  countableProducts,
  countSaveLabel,
  countsToSave,
  countSummary,
  inParts,
  rowProblem,
  withoutSaved,
  type CountDraft,
} from '../stockCount';

export function StockCountSheet({
  storeId,
  storeName,
  open,
  onClose,
}: {
  storeId: string;
  /** Shown under the title, so the count is not typed into the wrong store. */
  storeName?: string;
  open: boolean;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const unitLabel = useUnitLabel();
  const productName = useProductName();
  const productNameParts = useProductNameParts();
  const utils = trpc.useUtils();

  // The same queries as the Inventory tab, so they usually come from cache.
  const levelsQuery = trpc.inventory.levels.useQuery({ storeId }, { enabled: open });
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true }, { enabled: open });
  const categoriesQuery = trpc.catalog.categories.useQuery(undefined, { enabled: open });

  const [draft, setDraft] = useState<CountDraft>({});
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [saving, setSaving] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // A closed sheet starts empty next time (closing with counts typed asks
  // first: hasChanges below).
  useEffect(() => {
    if (!open) {
      setDraft({});
      setSearch('');
    }
  }, [open]);

  const products = useMemo(
    () => countableProducts(skusQuery.data ?? [], levelsQuery.data ?? []),
    [skusQuery.data, levelsQuery.data],
  );
  const onHandBySku = useMemo(() => new Map(products.map((p) => [p.id, p.onHand])), [products]);
  const categoryNameById = useMemo(
    () => new Map((categoriesQuery.data ?? []).map((c) => [c.id, productName({ names: c.names })])),
    [categoriesQuery.data, productName],
  );
  // As the order page lists products: by category in the admin's order;
  // while searching, one list in relevance order.
  const groups = useMemo(() => {
    const tokens = normalizeQuery(deferredSearch);
    if (tokens) {
      const found = rankNameLike(
        products,
        tokens,
        (p) => ({ names: p.names, code: p.code }),
        i18n.locale,
      );
      return found.length > 0
        ? [{ key: 'search', categoryId: null, archived: false, skus: found }]
        : [];
    }
    return groupCatalog(products, categoriesQuery.data ?? []);
  }, [products, categoriesQuery.data, deferredSearch, i18n.locale]);

  const summary = countSummary(draft, (skuId) => onHandBySku.get(skuId));

  // One idempotency key per part content: the same counts sent again (a
  // retry after a lost answer) reuse it; changed counts get a new one.
  const idemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  const keys = useRef(new Map<string, string>());
  const batch = trpc.inventory.stocktakeBatch.useMutation({ trpc: { context: idemCtx } });

  const save = async () => {
    const entries = countsToSave(draft);
    let rest: CountDraft = draft;
    setSaving(true);
    try {
      // A count of more products than one call takes goes in parts; a
      // part saved stays saved, and only the rest is left to retry.
      for (const part of inParts(entries, STOCKTAKE_BATCH_MAX)) {
        const signature = JSON.stringify(part);
        const key = keys.current.get(signature) ?? newIdempotencyKey();
        keys.current.set(signature, key);
        idemCtx.idempotencyKey = key;
        try {
          await batch.mutateAsync({ storeId, counts: part });
        } catch (err) {
          setDraft(rest);
          errToast('common.errors.actionFailed', { retrySafe: true })(err);
          return;
        }
        rest = withoutSaved(
          rest,
          part.map((p) => p.skuId),
        );
      }
      keys.current.clear();
      haptic('success');
      toast.success(i18n.t('inventory.count.saved', { n: entries.length }));
      setDraft({});
      onClose();
    } finally {
      setSaving(false);
      void utils.inventory.levels.invalidate({ storeId });
      void utils.inventory.recentMovements.invalidate({ storeId });
    }
  };

  // UX-06 (2026-11-13): no dialog in front of the save; the button says
  // what it records ("Save 2 counts · 1 differs").
  const onSave = () => {
    if (summary.counted === 0 || summary.invalid > 0 || saving) return;
    void save();
  };
  const saveLabel = countSaveLabel(summary);

  // The keyboard's next / enter key moves to the next row's field; on the
  // last row it closes the keyboard.
  const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isCommitEnter(event)) return;
    event.preventDefault();
    const fields = [
      ...(listRef.current?.querySelectorAll<HTMLInputElement>('input[data-count-field]') ?? []),
    ];
    const next = fields[fields.indexOf(event.currentTarget) + 1];
    if (next) next.focus();
    else event.currentTarget.blur();
  };

  const loading = levelsQuery.isLoading || skusQuery.isLoading;
  const failed = levelsQuery.isError ? levelsQuery : skusQuery.isError ? skusQuery : null;
  const lastId = groups.at(-1)?.skus.at(-1)?.id;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      // Counts typed and not saved: Esc, a backdrop tap or back ask first.
      hasChanges={summary.counted > 0}
      disableAutoFocus
      title={i18n.t('inventory.count.title')}
      description={storeName}
      footer={
        <Button
          block
          loading={saving}
          disabled={summary.counted === 0 || summary.invalid > 0}
          // UX-05: the kit's line over a disabled Save says why. Nothing
          // typed yet needs no line: the hint over the list says what to do.
          disabledHint={
            summary.invalid > 0 ? i18n.t('inventory.count.fixRows', { n: summary.invalid }) : ''
          }
          onClick={onSave}
        >
          {i18n.t(saveLabel.key, saveLabel.vars)}
        </Button>
      }
    >
      <div className="flex flex-col gap-3 py-3">
        <p className="text-old-body-sm text-[var(--c-fg-muted)]">
          {i18n.t('inventory.count.hint')}
        </p>
        <SearchInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClear={() => setSearch('')}
          placeholder={i18n.t('admin.search.skusPlaceholder')}
          aria-label={i18n.t('admin.search.skusPlaceholder')}
          clearAriaLabel={i18n.t('common.clear')}
        />
        {loading ? (
          <LoadingState variant="compact" />
        ) : failed ? (
          <QueryErrorBanner query={failed} />
        ) : groups.length === 0 ? (
          <EmptyState
            title={
              deferredSearch.trim()
                ? i18n.t('order.search.noMatches.title')
                : i18n.t('inventory.count.empty')
            }
          />
        ) : (
          <div ref={listRef} className="flex flex-col">
            {groups.map((group) => (
              <section key={group.key}>
                {group.key !== 'search' ? (
                  <SectionLabel as="h3" className="pb-1 pt-2">
                    {group.categoryId
                      ? (categoryNameById.get(group.categoryId) ?? '')
                      : i18n.t('order.categories.uncategorized')}
                  </SectionLabel>
                ) : null}
                <ul className={rowGroupClass} role="list">
                  {group.skus.map((p) => {
                    const parts = rowName(productNameParts, p, i18n.t('common.unknownProduct'));
                    const problem = rowProblem(draft, p.id);
                    const negative = p.onHand.startsWith('-');
                    const errorId = `count-error-${p.id}`;
                    return (
                      // Review MWD-07 (modern-web-guidance:
                      // defer-rendering-heavy-content): a field per product;
                      // rows off screen skip layout and paint, as on the
                      // order page (SkuRow.tsx). 60px: a row with its field.
                      <li
                        key={p.id}
                        className="px-4 py-2 [content-visibility:auto] [contain-intrinsic-size:auto_60px]"
                      >
                        <div className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <NameCell {...parts} />
                            <span
                              className={cn(
                                'block text-old-label tabular-nums text-[var(--c-fg-muted)]',
                                negative && 'font-semibold text-[var(--c-danger-ink)]',
                              )}
                            >
                              {i18n.t('inventory.count.onHand', {
                                qty: `${formatQty(p.onHand)} ${unitLabel(p.unit, p.onHand)}`.trim(),
                              })}
                            </span>
                          </div>
                          <Input
                            type="number"
                            formatError="none"
                            data-count-field=""
                            className="w-28 shrink-0 text-right"
                            enterKeyHint={p.id === lastId ? 'done' : 'next'}
                            aria-label={i18n.t('inventory.count.fieldAria', {
                              name: parts.primary,
                            })}
                            aria-describedby={problem ? errorId : undefined}
                            invalid={problem !== null}
                            value={draft[p.id] ?? ''}
                            onChange={(e) => {
                              const value = e.target.value;
                              setDraft((d) => ({ ...d, [p.id]: value }));
                            }}
                            onKeyDown={onFieldKey}
                          />
                        </div>
                        {problem ? (
                          <FieldError id={errorId} className="text-right">
                            {i18n.t(STOCKTAKE_COUNT_MESSAGE[problem])}
                          </FieldError>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
