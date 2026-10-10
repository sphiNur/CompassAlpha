import { useCallback, useMemo, useState } from 'react';
import { useToast } from '@compass/ui';
import {
  Button,
  ChoiceGroup,
  Field,
  List,
  Money,
  Row,
  Section,
  Sheet,
  StatusChip,
} from '@compass/ui/kit';
import { trpc } from '../../../lib/trpc';
import { useAuthStore } from '../../../stores/authStore';
import { useErrToast } from '../../../lib/errToast';
import { shareLink } from '../../../lib/telegramLinks';
import { formatMoney, formatQty } from '../../../lib/format';
import type { useI18n } from '../../../hooks/useI18n';
import { haptic, getTg } from '../../../hooks/useTelegram';
import { normalizeQuery } from '../../../lib/searchMatch';
import type { PreviewLine, PreviewStoreGroup, PreviewSupplierGroup } from '../types';
import {
  buildStoreText as buildStoreTextPure,
  buildSupplierText as buildSupplierTextPure,
} from '../lib/shareText';
import type { ShareTextDeps } from '../lib/shareText';
import { computePreviewStats } from '../lib/previewStats';
import {
  countStoreLines,
  countSupplierLines,
  filterStoreGroups,
  filterSupplierGroups,
} from '../lib/previewFilter';
import { groupStoreBySupplier } from '../lib/previewGrouping';

type PreviewView = 'byStore' | 'bySupplier';
const PREVIEW_VIEW_STORAGE_KEY = 'compass.runPreview.view';
const UNASSIGNED = '__unassigned__';

function previewLineTotal(qty: string, unitPrice: string | null): number | null {
  if (!unitPrice) return null;
  const qtyNum = Number(qty);
  const priceNum = Number(unitPrice);
  if (!Number.isFinite(qtyNum) || !Number.isFinite(priceNum)) return null;
  return qtyNum * priceNum;
}

function addPreviewLine(group: PreviewStoreGroup, line: PreviewLine): void {
  group.items.push(line);
  if (line.total === null) group.unknownCount += 1;
  else group.total += line.total;
}

export interface RunPreviewProps {
  preview: {
    // M3.24 (2026-05-18): nullable when the caller didn't ask for a
    // specific date — preview then spans every approved-not-in-run
    // session regardless of order_date.
    date: string | null;
    sessions: ReadonlyArray<{ id: string; storeId: string; storeName?: string; orderDate?: string }>;
    plannedItems: ReadonlyArray<{ skuId: string; qty: string }>;
    perStoreDemand: ReadonlyArray<{
      storeId: string;
      storeName: string;
      skuId: string;
      qty: string;
    }>;
    supplierBySku: Record<string, {
      id: string;
      name: string;
      contactPhone: string | null;
      contactTg: string | null;
      defaultPrice?: string | null;
      lastSeenPrice?: string | null;
      estimatedUnitPrice?: string | null;
    } | null>;
    lastPurchasePriceBySku?: Record<string, string>;
    perStoreBudgets?: ReadonlyArray<{
      storeId: string;
      storeName: string;
      estimatedTotal: string;
      unknownPriceCount: number;
    }>;
    /** M1.8: per-store concatenated session notes ("其他物品", legacy). */
    sessionNotesByStore?: Record<string, string>;
    /** M3.16-C: per-store structured extras. */
    sessionExtrasByStore?: Record<
      string,
      Array<{ name: string; qty: string; unit: string; note?: string; sessionId?: string; idx?: number }>
    >;
  };
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  toast: ReturnType<typeof useToast>;
  /**
   * Whether to name the screen. Before a run exists this is the page and
   * says so; a run sent back to planning already has the run's heading.
   */
  heading: boolean;
}

/**
 * What is about to be bought, before the trip starts: what it will cost
 * as far as known prices go, what is missing (a stall, a price), and the
 * list cut two ways. By store answers "what does each store get"; by
 * stall is what the purchaser sends ahead so the stall can have each
 * store's share packed.
 *
 * A trip is 80-odd lines, so a group shows as one row (name, how many,
 * what it comes to) and opens into a sheet with its lines and the button
 * that sends them.
 */
export function RunPreview({ preview, skuById, productName, i18n, toast, heading }: RunPreviewProps) {
  const [view, setView] = useState<PreviewView>(() => {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem(PREVIEW_VIEW_STORAGE_KEY);
      if (v === 'byStore' || v === 'bySupplier') return v;
    }
    // By stall is only worth opening on once stalls have been assigned,
    // which is done by hand, one product at a time. Until most are, it
    // would be a single "no stall" group.
    const planned = preview.plannedItems;
    if (planned.length === 0) return 'byStore';
    const assigned = planned.filter((it) => preview.supplierBySku[it.skuId]).length;
    return assigned / planned.length >= 0.5 ? 'bySupplier' : 'byStore';
  });
  const [vendorPickerFor, setVendorPickerFor] = useState<string | null>(null);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const currentUnitLabel = useCallback(
    (unit: string | null | undefined): string => {
      if (!unit) return '';
      const canonical = unit.toLowerCase();
      const key = ('unit.' + canonical) as Parameters<typeof i18n.t>[0];
      const localized = i18n.t(key);
      return localized === key ? unit : localized;
    },
    [i18n],
  );
  const currentSkuName = useCallback(
    (item: { names: Record<string, string> | null | undefined }): string => {
      const names = item.names ?? {};
      return (
        names[i18n.locale] ??
        names.en ??
        names.ru ??
        names.zh ??
        names.uz ??
        Object.values(names)[0] ??
        '—'
      );
    },
    [i18n.locale],
  );
  /**
   * Persist only what the user CHOSE, never the computed default.
   *
   * This used to be a `useEffect` on [view], which wrote on first mount
   * — so the adaptive default got stored as if it were a preference and
   * every later visit read it back instead of re-deriving. Caught on a
   * real dev instance (2026-07-26): the very first page load happened
   * with no approved orders, the initializer correctly fell back to
   * byStore for an empty preview, that got persisted, and afterwards the
   * card stayed on byStore even at 84/93 SKUs assigned to stalls, where
   * bySupplier is the whole point. The old constant default hid this;
   * an adaptive one cannot afford it.
   */
  const chooseView = useCallback((v: PreviewView) => {
    setView(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PREVIEW_VIEW_STORAGE_KEY, v);
    }
  }, []);

  const storeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of preview.perStoreDemand) m.set(row.storeId, row.storeName);
    for (const row of preview.perStoreBudgets ?? []) m.set(row.storeId, row.storeName);
    for (const row of preview.sessions) {
      if (row.storeName) m.set(row.storeId, row.storeName);
    }
    return m;
  }, [preview.perStoreBudgets, preview.perStoreDemand, preview.sessions]);

  const estimatedPriceForSku = useCallback(
    (skuId: string): string | null =>
      preview.lastPurchasePriceBySku?.[skuId] ??
      preview.supplierBySku[skuId]?.estimatedUnitPrice ??
      null,
    [preview.lastPurchasePriceBySku, preview.supplierBySku],
  );

  const ensurePreviewStoreGroup = useCallback(
    (m: Map<string, PreviewStoreGroup>, storeId: string, storeName?: string) => {
      let cur = m.get(storeId);
      if (!cur) {
        cur = {
          storeId,
          storeName: storeName ?? storeNameById.get(storeId) ?? storeId.slice(0, 8),
          items: [],
          total: 0,
          unknownCount: 0,
        };
        m.set(storeId, cur);
      } else if (storeName && cur.storeName === storeId.slice(0, 8)) {
        cur.storeName = storeName;
      }
      return cur;
    },
    [storeNameById],
  );

  const byStore = useMemo(() => {
    const m = new Map<string, PreviewStoreGroup>();
    for (const row of preview.perStoreDemand) {
      const sku = skuById.get(row.skuId);
      const unitPrice = estimatedPriceForSku(row.skuId);
      const group = ensurePreviewStoreGroup(m, row.storeId, row.storeName);
      const supplier = preview.supplierBySku[row.skuId] ?? null;
      addPreviewLine(group, {
        id: `sku:${row.storeId}:${row.skuId}`,
        kind: 'sku',
        skuId: row.skuId,
        name: sku ? productName(sku) : row.skuId.slice(0, 8),
        qty: row.qty,
        unit: currentUnitLabel(sku?.unit),
        unitPrice,
        total: previewLineTotal(row.qty, unitPrice),
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? null,
      });
    }

    for (const [storeId, extras] of Object.entries(preview.sessionExtrasByStore ?? {})) {
      const group = ensurePreviewStoreGroup(m, storeId);
      for (const ex of extras) {
        addPreviewLine(group, {
          id: `extra:${storeId}:${ex.sessionId ?? ''}:${ex.idx ?? group.items.length}:${ex.name}`,
          kind: 'extra',
          skuId: null,
          name: ex.name,
          qty: ex.qty,
          unit: ex.unit,
          unitPrice: null,
          total: null,
          note: ex.note,
        });
      }
    }

    for (const [storeId, note] of Object.entries(preview.sessionNotesByStore ?? {})) {
      const trimmed = note.trim();
      if (!trimmed) continue;
      ensurePreviewStoreGroup(m, storeId).legacyNote = trimmed;
    }

    // Order within a store: catalog SKUs before off-catalog extras, then
    // by stall, then by name. Grouping by stall inside the store is the
    // cheap way to get the visual clustering a nested store→stall→item
    // tree would give, without a second level of headers eating ~28px
    // each on a 375px screen. Unassigned SKUs sink to the bottom of the
    // SKU block so the "no stall" exception reads as a tail, not noise
    // sprinkled through the list.
    //
    // This also fixes a real defect: `perStoreDemand` comes from an
    // unordered orderItemsV query, so the previous row order was
    // Postgres heap order.
    for (const g of m.values()) {
      g.items.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'sku' ? -1 : 1;
        const an = a.supplierName ?? null;
        const bn = b.supplierName ?? null;
        if (an !== bn) {
          if (an === null) return 1;
          if (bn === null) return -1;
          const bySupplierName = an.localeCompare(bn);
          if (bySupplierName !== 0) return bySupplierName;
        }
        return a.name.localeCompare(b.name);
      });
    }

    return [...m.values()]
      .filter((g) => g.items.length > 0 || g.legacyNote)
      .sort((a, b) => a.storeName.localeCompare(b.storeName));
  }, [
    ensurePreviewStoreGroup,
    currentUnitLabel,
    estimatedPriceForSku,
    preview.perStoreDemand,
    preview.sessionExtrasByStore,
    preview.sessionNotesByStore,
    preview.supplierBySku,
    productName,
    skuById,
  ]);

  const bySupplier = useMemo(() => {
    const buckets = new Map<string, PreviewSupplierGroup>();
    const ensureSupplier = (
      supplierId: string | null,
      supplierName: string,
      contactPhone: string | null,
      contactTg: string | null,
    ) => {
      const key = supplierId ?? '__unassigned__';
      let cur = buckets.get(key);
      if (!cur) {
        cur = {
          supplierId,
          supplierName,
          contactPhone,
          contactTg,
          stores: [],
          total: 0,
          unknownCount: 0,
        };
        buckets.set(key, cur);
      }
      return cur;
    };
    const ensureSupplierStore = (
      supplier: PreviewSupplierGroup,
      storeId: string,
      storeName: string,
    ) => {
      let cur = supplier.stores.find((s) => s.storeId === storeId);
      if (!cur) {
        cur = {
          storeId,
          storeName,
          items: [],
          total: 0,
          unknownCount: 0,
        };
        supplier.stores.push(cur);
      }
      return cur;
    };

    for (const store of byStore) {
      for (const line of store.items) {
        // Read the id the LINE already carries rather than re-resolving
        // from preview.supplierBySku — one resolve point means the two
        // views cannot drift about where an item comes from.
        const supplier =
          line.kind === 'sku' && line.supplierId
            ? preview.supplierBySku[line.skuId!] ?? null
            : null;
        const bucket = ensureSupplier(
          supplier?.id ?? null,
          supplier?.name ?? i18n.t('run.previewSupplier.unassigned'),
          supplier?.contactPhone ?? null,
          supplier?.contactTg ?? null,
        );
        const storeBucket = ensureSupplierStore(bucket, store.storeId, store.storeName);
        addPreviewLine(storeBucket, line);
        if (line.total === null) bucket.unknownCount += 1;
        else bucket.total += line.total;
      }
      if (store.legacyNote) {
        const bucket = ensureSupplier(
          null,
          i18n.t('run.previewSupplier.unassigned'),
          null,
          null,
        );
        ensureSupplierStore(bucket, store.storeId, store.storeName).legacyNote =
          store.legacyNote;
      }
    }

    return [...buckets.values()]
      .map((b) => ({
        ...b,
        stores: b.stores.sort((a, b2) => a.storeName.localeCompare(b2.storeName)),
      }))
      .sort((a, b) => {
        if (a.supplierId === null) return 1;
        if (b.supplierId === null) return -1;
        return a.supplierName.localeCompare(b.supplierName);
      });
  }, [byStore, i18n, preview.supplierBySku]);

  /**
   * Run-wide facts for the header. Derived from the CLIENT byStore memo,
   * deliberately not from the server's `preview.perStoreBudgets`: that is
   * built from order_items_v alone, so it cannot see `extrasJson`, while
   * `addPreviewLine` counts extras as unpriced. The two disagree about
   * the same store today — one of them had to win, and only the client
   * number matches what is rendered directly underneath it.
   *
   * Counts are of DISTINCT items, not of rows: a SKU three stores want
   * is one thing to buy, and "无摊位 3" meaning one SKU across three
   * stores would be a lie. Extras key on name+unit, the same merge rule
   * the vendor share-text uses.
   */
  const previewStats = useMemo(
    () =>
      computePreviewStats(byStore, (skuId) => Boolean(preview.supplierBySku[skuId])),
    [byStore, preview.supplierBySku],
  );

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for environments without clipboard API.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      return true;
    } catch {
      return false;
    }
  };

  const shareOrCopyText = async (text: string): Promise<void> => {
    const copied = await copyToClipboard(text);
    let opened = false;
    const url = shareLink({ url: '', text });
    try {
      const tg = getTg();
      if (tg?.openTelegramLink) {
        tg.openTelegramLink(url);
        opened = true;
      } else if (typeof window !== 'undefined') {
        opened = window.open(url, '_blank', 'noopener,noreferrer') !== null;
      }
    } catch {
      opened = false;
    }
    if (opened) {
      toast.success(
        i18n.t(copied ? 'run.previewShare.openedWithCopy' : 'run.previewShare.opened'),
      );
      haptic('success');
      return;
    }
    if (copied) {
      toast.success(i18n.t('run.previewStore.copied'));
      haptic('success');
      return;
    }
    toast.error(i18n.t('common.error'));
  };

  /**
   * Catalog + i18n bindings handed to the pure builders in
   * `../lib/shareText`. The builders themselves live outside this
   * component so the vendor-vs-store disclosure boundary is unit-tested
   * (see runs/lib/__tests__/shareText.test.ts) rather than eyeballed.
   */
  // Deliberately NOT memoized. `useI18n` returns a memo keyed on the
  // resolved locale, so its identity does NOT change when a lazily
  // imported catalog chunk lands — `useEnsureLocale` re-renders via a
  // state counter instead. A useMemo here would therefore freeze
  // extrasLabel / notesLabel at whatever the fallback catalog said on
  // first render (English, if the user's locale chunk was still in
  // flight on bazaar LTE) for the entire mount. Rebuilding this small
  // object each render restores the live read the old inline closures
  // had; the builders themselves only run on a button tap.
  const shareDeps: ShareTextDeps = {
    resolveSku: (skuId: string) => {
      const sku = skuById.get(skuId);
      if (!sku) return null;
      return { name: currentSkuName(sku), unit: currentUnitLabel(sku.unit) };
    },
    extrasLabel: i18n.t('order.extras.label'),
    notesLabel: i18n.t('order.notes.label'),
  };

  const buildStoreText = (group: PreviewStoreGroup): string =>
    buildStoreTextPure(group, shareDeps);

  const buildSupplierText = (group: PreviewSupplierGroup): string =>
    buildSupplierTextPure(group, shareDeps);

  const buildAllVendorsText = (): string =>
    bySupplier.map((b) => buildSupplierText(b)).filter(Boolean).join('\n\n');

  /**
   * Name filter. A group shows only its name and total until it is
   * opened, so finding one product ("this stall is out of tomatoes, who
   * else wanted them?") would mean opening every group in turn. While a
   * query is typed the groups give way to the matching lines themselves.
   */
  const [filterText, setFilterText] = useState('');
  const filterTokens = useMemo(() => normalizeQuery(filterText) ?? [], [filterText]);
  const filtering = filterTokens.length > 0;
  // Other-language names for the SKU behind a line, so a Russian speaker
  // finds a row whose display name resolved to Chinese.
  const lineHaystack = useCallback(
    (line: PreviewLine) => {
      const sku = line.skuId ? skuById.get(line.skuId) : null;
      return sku ? Object.values(sku.names ?? {}) : [];
    },
    [skuById],
  );
  const visibleByStore = useMemo(
    () => filterStoreGroups(byStore, filterTokens, lineHaystack),
    [byStore, filterTokens, lineHaystack],
  );
  const visibleBySupplier = useMemo(
    () => filterSupplierGroups(bySupplier, filterTokens, lineHaystack),
    [bySupplier, filterTokens, lineHaystack],
  );
  const matchCount =
    view === 'byStore' ? countStoreLines(visibleByStore) : countSupplierLines(visibleBySupplier);
  const totalCount =
    view === 'byStore' ? countStoreLines(byStore) : countSupplierLines(bySupplier);


  const chooseAndClose = (v: PreviewView) => {
    setOpenGroup(null);
    chooseView(v);
  };

  /** One line of the list: what, how much at what price, what it comes to. */
  const lineRow = (line: PreviewLine, where: string | null, onPress?: () => void) => {
    const qtyUnit = `${formatQty(line.qty)} ${line.unit}`.trim();
    const detail = [
      line.unitPrice ? `${qtyUnit} × ${formatMoney(line.unitPrice)}` : qtyUnit,
      where,
      line.note,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <Row
        key={line.id}
        data-testid="preview-line"
        title={line.name}
        detail={detail}
        value={
          line.total === null ? (
            <StatusChip tone="pending">{i18n.t('run.preview.priceUnknown')}</StatusChip>
          ) : (
            <Money amount={formatMoney(line.total)} />
          )
        }
        onPress={onPress}
      />
    );
  };

  const groupDetail = (lines: number, unknown: number, extra?: string | null): string =>
    [
      i18n.t('run.label.itemsCount', { n: lines }),
      unknown > 0 ? i18n.t('run.preview.unknownPrices', { n: unknown }) : null,
      extra,
    ]
      .filter(Boolean)
      .join(' · ');

  // Nothing priced yet is not a total of zero: say nothing rather than "0".
  const known = (total: number) =>
    total > 0 ? <Money amount={formatMoney(total)} /> : undefined;

  const subheading = (name: string, total: number) => (
    <h3 className="flex items-baseline justify-between gap-lg text-label text-secondary">
      <span className="min-w-0">{name}</span>
      {total > 0 ? <span className="shrink-0">{formatMoney(total)}</span> : null}
    </h3>
  );

  const note = (text: string) => (
    <p className="whitespace-pre-wrap text-body text-secondary">{text}</p>
  );

  const openStore = view === 'byStore' ? byStore.find((g) => g.storeId === openGroup) : undefined;
  const openSupplier =
    view === 'bySupplier'
      ? bySupplier.find((b) => (b.supplierId ?? UNASSIGNED) === openGroup)
      : undefined;
  const noPrice = previewStats.total - previewStats.known;

  return (
    <div className="flex flex-col gap-xl">
      <header>
        {heading ? <h1 className="text-h1 text-ink">{i18n.t('run.section.readyToPlan')}</h1> : null}
        {/* How far known prices go, not a budget: lines without a price
            are left out, and porters and fees do not exist yet. Hence
            "at least". */}
        <p className="text-body text-secondary">
          {i18n.t('run.label.sessionsCount', { n: preview.sessions.length })}
          {' · '}
          {i18n.t('run.preview.coverage', {
            known: previewStats.known,
            total: previewStats.total,
            money: formatMoney(previewStats.knownTotal, currency),
          })}
        </p>
        {/* What the button below does that cannot be seen from it. */}
        {heading && preview.sessions.length > 0 ? (
          <p className="pt-sm text-body text-secondary">
            {i18n.t('run.banner.planLockWarning', { n: preview.sessions.length })}
          </p>
        ) : null}
      </header>

      {previewStats.noSupplier > 0 || noPrice > 0 ? (
        <List>
          {previewStats.noSupplier > 0 ? (
            // Opens where they can be fixed: under "no stall", a line
            // opens the stall picker.
            <Row
              data-testid="preview-no-stall"
              title={i18n.t('run.preview.noSupplierCount', { n: previewStats.noSupplier })}
              onPress={() => {
                chooseView('bySupplier');
                setOpenGroup(UNASSIGNED);
              }}
            />
          ) : null}
          {noPrice > 0 ? (
            <Row title={i18n.t('run.preview.unknownPrices', { n: noPrice })} />
          ) : null}
        </List>
      ) : null}

      {totalCount >= 8 ? (
        <Field
          type="search"
          label={i18n.t('order.search.placeholder') as string}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
      ) : null}

      <ChoiceGroup<PreviewView>
        compact
        label={i18n.t('run.view.ariaLabel') as string}
        value={view}
        onChange={chooseAndClose}
        options={[
          { value: 'byStore', label: i18n.t('run.previewView.byStore') as string },
          { value: 'bySupplier', label: i18n.t('run.previewView.bySupplier') as string },
        ]}
      />

      {filtering ? (
        <Section
          title={i18n.t('run.preview.filterMatch', { n: matchCount, total: totalCount }) as string}
        >
          {matchCount === 0 ? (
            <p className="text-body text-secondary">
              {i18n.t('order.search.noMatches.description')}
            </p>
          ) : (
            <List>
              {view === 'byStore'
                ? visibleByStore.flatMap((g) => g.items.map((l) => lineRow(l, g.storeName)))
                : visibleBySupplier.flatMap((b) =>
                    b.stores.flatMap((s) =>
                      s.items.map((l) => lineRow(l, `${b.supplierName}, ${s.storeName}`)),
                    ),
                  )}
            </List>
          )}
        </Section>
      ) : view === 'byStore' ? (
        <List>
          {byStore.map((g) => (
            <Row
              key={g.storeId}
              data-testid="preview-group"
              title={g.storeName}
              detail={groupDetail(g.items.length, g.unknownCount)}
              value={known(g.total)}
              onPress={() => setOpenGroup(g.storeId)}
            />
          ))}
        </List>
      ) : (
        <List>
          {bySupplier.map((b) => (
            <Row
              key={b.supplierId ?? UNASSIGNED}
              data-testid="preview-group"
              title={b.supplierName}
              detail={groupDetail(
                countSupplierLines([b]),
                b.unknownCount,
                b.contactTg ? `@${b.contactTg}` : b.contactPhone,
              )}
              value={known(b.total)}
              onPress={() => setOpenGroup(b.supplierId ?? UNASSIGNED)}
            />
          ))}
          {bySupplier.length > 1 ? (
            // One block for a notebook, or to forward whole.
            <Row
              action
              data-testid="preview-send-all"
              title={i18n.t('run.previewShare.sendAll')}
              onPress={() => void shareOrCopyText(buildAllVendorsText())}
            />
          ) : null}
        </List>
      )}

      {openStore ? (
        <Sheet
          open
          onOpenChange={(open) => !open && setOpenGroup(null)}
          title={openStore.storeName}
          actions={
            <Button
              variant="primary"
              data-testid="preview-send"
              onClick={() => void shareOrCopyText(buildStoreText(openStore))}
            >
              {i18n.t('buy.sendList')}
            </Button>
          }
        >
          <div className="flex flex-col gap-lg">
            {groupStoreBySupplier(openStore, i18n.t('run.previewSupplier.unassigned')).map(
              (stall) => (
                <div key={stall.supplierId ?? UNASSIGNED} className="flex flex-col gap-sm">
                  {subheading(stall.supplierName, stall.total)}
                  <List>{stall.items.map((l) => lineRow(l, null))}</List>
                </div>
              ),
            )}
            {openStore.legacyNote ? note(openStore.legacyNote) : null}
          </div>
        </Sheet>
      ) : null}

      {openSupplier ? (
        <Sheet
          open
          onOpenChange={(open) => !open && setOpenGroup(null)}
          title={openSupplier.supplierName}
          actions={
            <Button
              variant="primary"
              data-testid="preview-send"
              onClick={() => void shareOrCopyText(buildSupplierText(openSupplier))}
            >
              {i18n.t('buy.sendList')}
            </Button>
          }
        >
          <div className="flex flex-col gap-lg">
            {!openSupplier.supplierId ? note(i18n.t('buy.noStallHint') as string) : null}
            {openSupplier.stores.map((store) => (
              <div key={store.storeId} className="flex flex-col gap-sm">
                {subheading(store.storeName, store.total)}
                <List>
                  {store.items.map((l) =>
                    lineRow(
                      l,
                      null,
                      // A catalogue line opens the stall picker; something a
                      // store typed in by hand has no stall to give it.
                      l.kind === 'sku' && l.skuId
                        ? () => {
                            setOpenGroup(null);
                            setVendorPickerFor(l.skuId);
                          }
                        : undefined,
                    ),
                  )}
                </List>
                {store.legacyNote ? note(store.legacyNote) : null}
              </div>
            ))}
          </div>
        </Sheet>
      ) : null}

      {vendorPickerFor ? (
        <StallPickerSheet
          skuId={vendorPickerFor}
          skuName={
            skuById.get(vendorPickerFor)
              ? productName(skuById.get(vendorPickerFor)!)
              : vendorPickerFor.slice(0, 8)
          }
          currentSupplierId={preview.supplierBySku[vendorPickerFor]?.id ?? null}
          onClose={() => setVendorPickerFor(null)}
          i18n={i18n}
          toast={toast}
        />
      ) : null}
    </div>
  );
}

/**
 * Sets the stall a product is usually bought at. It holds for every
 * later trip until changed here again.
 */
function StallPickerSheet({
  skuId,
  skuName,
  currentSupplierId,
  onClose,
  i18n,
  toast,
}: {
  skuId: string;
  skuName: string;
  currentSupplierId: string | null;
  onClose: () => void;
  i18n: ReturnType<typeof useI18n>;
  toast: ReturnType<typeof useToast>;
}) {
  const utils = trpc.useUtils();
  // Loaded on opening, so a stall added a minute ago is in the list.
  const suppliersQuery = trpc.admin.supplierList.useQuery();
  // The server answers with message keys; this turns them into words.
  const errToast = useErrToast();
  const setSupplier = trpc.run.setSkuPreferredSupplier.useMutation({
    onSuccess: (_data, vars) => {
      void utils.run.previewCreatable.invalidate();
      toast.success(
        i18n.t(vars.supplierId ? 'run.previewSupplier.assigned' : 'run.previewSupplier.cleared'),
      );
      onClose();
    },
    onError: errToast('common.error'),
  });
  const current = <StatusChip tone="done">{i18n.t('storeSwitcher.current')}</StatusChip>;

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && !setSupplier.isPending && onClose()}
      title={skuName}
      keepFocus
    >
      <div className="flex flex-col gap-lg">
        <p className="text-body text-secondary">{i18n.t('run.previewSupplier.pickVendorHint')}</p>
        <List>
          {(suppliersQuery.data ?? []).map((stall) => (
            <Row
              key={stall.id}
              picks
              data-testid="stall-option"
              title={stall.name}
              detail={stall.contactTg ? `@${stall.contactTg}` : (stall.contactPhone ?? undefined)}
              value={stall.id === currentSupplierId ? current : undefined}
              disabled={setSupplier.isPending}
              onPress={() => setSupplier.mutate({ skuId, supplierId: stall.id })}
            />
          ))}
          <Row
            picks
            title={i18n.t('buy.noStall')}
            value={currentSupplierId === null ? current : undefined}
            disabled={setSupplier.isPending}
            onPress={() => setSupplier.mutate({ skuId, supplierId: null })}
          />
        </List>
      </div>
    </Sheet>
  );
}
