/**
 * Store → Inventory: the sheet that records a stocktake (also a product's
 * opening count) or a wastage. Review ADM2-11 (2026-11-11): its own
 * component; it lived inside StoreInventoryTab with the list and the
 * movements sheet.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Select, Sheet, readDecimalText, useToast } from '@compass/ui';
import {
  INVENTORY_NOTE_MAX,
  STOCKTAKE_COUNT_MESSAGE,
  stocktakeCountProblem,
} from '@compass/contracts/limits';
import { newIdempotencyKey, trpc } from '../../../../lib/trpc';
import { useErrToast } from '../../../../hooks/useErrToast';
import { formatQty } from '../../../../lib/format';
import { useI18n, useProductName, useUnitLabel } from '../../../../hooks/useI18n';
import { nativeConfirm } from '../../shared';
import {
  inventoryDraftChanged,
  stockAfterWastage,
  stocktakeDiff,
  stocktakePrefill,
  WASTAGE_GAP_MESSAGE,
  wastageMissing,
} from '../inventoryHelpers';

/** A product as the inventory screens use it. */
export interface InventorySku {
  id: string;
  names: Record<string, string>;
  unit: string;
  step: string;
  isArchived: boolean;
}

/** What the sheet records: a count (stocktake) or a wastage. */
export type InventoryAction =
  // `pickSku`: opening stocktake — the SKU is chosen inside the sheet.
  | { kind: 'stocktake'; skuId: string; current: string; pickSku?: boolean }
  | { kind: 'wastage'; skuId: string };

export function InventoryActionSheet({
  storeId,
  action,
  onActionChange,
  skuById,
  openingCandidates,
  onHand,
}: {
  storeId: string;
  /** What to record; null keeps the sheet closed. */
  action: InventoryAction | null;
  /** The opening count's product picker changes the action; null closes. */
  onActionChange: (action: InventoryAction | null) => void;
  skuById: ReadonlyMap<string, InventorySku>;
  /** Active products with no stock row here yet, for an opening count. */
  openingCandidates: ReadonlyArray<{ id: string; name: string }>;
  /** A product's stock on hand here, '0' when it has none. */
  onHand: (skuId: string) => string;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const toast = useToast();
  const errToast = useErrToast();
  const productName = useProductName();
  const utils = trpc.useUtils();
  const [draftTarget, setDraftTarget] = useState('');
  const [draftWasteQty, setDraftWasteQty] = useState('');
  const [draftNote, setDraftNote] = useState('');

  // 2026-10-21 audit CA-54: one stable idempotency key per logical
  // wastage entry — minted when the sheet (re)arms, reused across
  // retries of the same submit, rotated after success. Same shape as
  // the sales form below. NOTE: the header is only sent once
  // 'inventory.recordWastage' is in lib/trpc.ts IDEMPOTENT_MUTATIONS.
  const wastageIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  useEffect(() => {
    wastageIdemCtx.idempotencyKey = newIdempotencyKey();
  }, [wastageIdemCtx, action, draftWasteQty, draftNote]);
  // DX-INV-2 (2026-11-01): the same for a stocktake. A retry of one count
  // replays on the server instead of posting a second correction.
  const stocktakeIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  useEffect(() => {
    stocktakeIdemCtx.idempotencyKey = newIdempotencyKey();
  }, [stocktakeIdemCtx, action, draftTarget, draftNote]);

  useEffect(() => {
    if (!action) {
      setDraftTarget('');
      setDraftWasteQty('');
      setDraftNote('');
    } else if (action.kind === 'stocktake') {
      setDraftTarget(stocktakePrefill(action.current));
    }
  }, [action]);

  const wasteMissing = wastageMissing(draftWasteQty, draftNote, readDecimalText);
  // DX-INV-1 (2026-11-01): the server's count check, run before Save. The
  // field hands us the normalised number, or the text as typed when it
  // is not one ("abc"), which the check calls notNumber.
  const countProblem = action?.kind === 'stocktake' ? stocktakeCountProblem(draftTarget) : null;

  const stocktake = trpc.inventory.stocktake.useMutation({
    trpc: { context: stocktakeIdemCtx },
    onSuccess: () => {
      stocktakeIdemCtx.idempotencyKey = newIdempotencyKey();
      void utils.inventory.levels.invalidate({ storeId });
      void utils.inventory.recentMovements.invalidate({ storeId });
      toast.success(i18n.t('inventory.toast.stocktakeSaved'));
      onActionChange(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const recordWastage = trpc.inventory.recordWastage.useMutation({
    trpc: { context: wastageIdemCtx },
    onSuccess: () => {
      wastageIdemCtx.idempotencyKey = newIdempotencyKey();
      void utils.inventory.levels.invalidate({ storeId });
      void utils.inventory.recentMovements.invalidate({ storeId });
      toast.success(i18n.t('inventory.toast.wastageSaved'));
      onActionChange(null);
    },
    onError: errToast('common.errors.actionFailed'),
  });

  return (
    <Sheet
      open={action !== null}
      onOpenChange={(open) => !open && onActionChange(null)}
      // CMP-INV-2: Esc / backdrop / back no longer drop a typed count.
      hasChanges={inventoryDraftChanged(action, {
        target: draftTarget,
        wasteQty: draftWasteQty,
        note: draftNote,
      })}
      title={
        action?.kind === 'stocktake'
          ? i18n.t('inventory.sheet.stocktake.title')
          : i18n.t('inventory.sheet.wastage.title')
      }
      description={
        action && action.skuId ? productName({ names: skuById.get(action.skuId)?.names ?? {} }) : ''
      }
      footer={
        // 2026-07-30: dropped `!getTg() &&` — same defect as the dish
        // editor. `getTg()` is truthy in any browser (the Telegram SDK
        // is a static script tag), and nothing drives the native
        // MainButton for this sheet, so stocktake / wastage had no
        // submit button in any environment. See the dish editor's
        // footer (catalog/DishesSection.tsx) for the full write-up.
        action ? (
          <>
            {/* CMP-INV-3: wastage can only be saved once it is complete,
                  and the line above Save says what is missing. */}
            {/* DX-INV-1: an empty count says what is missing here, like
                  wastage; a wrong one says why under the field. */}
            {action.kind === 'stocktake' && countProblem === 'empty' ? (
              <p
                id="stocktake-missing"
                className="pb-2 text-center text-old-body-sm text-[var(--c-fg-muted)]"
              >
                {i18n.t(STOCKTAKE_COUNT_MESSAGE.empty)}
              </p>
            ) : null}
            {action.kind === 'wastage' && wasteMissing ? (
              <p
                id="wastage-missing"
                className="pb-2 text-center text-old-body-sm text-[var(--c-fg-muted)]"
              >
                {i18n.t(WASTAGE_GAP_MESSAGE[wasteMissing])}
              </p>
            ) : null}
            <Button
              block
              loading={stocktake.isPending || recordWastage.isPending}
              disabled={
                !action.skuId ||
                (action.kind === 'wastage' && wasteMissing !== null) ||
                (action.kind === 'stocktake' && countProblem !== null)
              }
              aria-describedby={
                action.kind === 'wastage' && wasteMissing
                  ? 'wastage-missing'
                  : countProblem === 'empty'
                    ? 'stocktake-missing'
                    : countProblem
                      ? 'stocktake-error'
                      : undefined
              }
              onClick={() => {
                if (!action || !action.skuId) return;
                if (action.kind === 'stocktake') {
                  if (countProblem) return;
                  stocktake.mutate({
                    storeId,
                    skuId: action.skuId,
                    target: draftTarget,
                    note: draftNote.trim() || undefined,
                  });
                } else {
                  if (wasteMissing) return;
                  const save = () =>
                    recordWastage.mutate({
                      storeId,
                      skuId: action.skuId,
                      qty: draftWasteQty,
                      note: draftNote.trim(),
                    });
                  // CLS-8 (2026-10-30, owner decision): allowed, but said out
                  // loud — stock that goes negative means the record was
                  // already off, and a stocktake is the fix.
                  const after = stockAfterWastage(
                    onHand(action.skuId),
                    draftWasteQty,
                    readDecimalText,
                  );
                  if (after !== null && Number(after) < 0) {
                    nativeConfirm(
                      i18n.t('inventory.confirm.wastageNegative', { after: formatQty(after) }),
                      save,
                    );
                  } else {
                    save();
                  }
                }
              }}
            >
              {i18n.t('common.save')}
            </Button>
          </>
        ) : null
      }
    >
      {action ? (
        <div className="flex flex-col gap-3 py-3">
          {action.kind === 'stocktake' ? (
            <>
              {action.pickSku ? (
                <Field label={i18n.t('inventory.sheet.stocktake.skuLabel')}>
                  <Select
                    value={action.skuId}
                    aria-label={i18n.t('inventory.sheet.stocktake.skuLabel')}
                    onChange={(e) => onActionChange({ ...action, skuId: e.target.value })}
                  >
                    <option value="">{i18n.t('inventory.sheet.stocktake.pickSku')}</option>
                    {openingCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3 text-old-label text-[var(--c-fg-muted)]">
                {i18n.t('inventory.sheet.stocktake.systemSays', {
                  qty: formatQty(action.current),
                })}
              </div>
              {/* DX-INV-1: the reason a count can't be saved sits under the
                    field and is tied to it, as in the daily close. */}
              <Field
                label={i18n.t('inventory.sheet.stocktake.targetLabel')}
                hint={i18n.t('inventory.sheet.stocktake.targetHint')}
                error={
                  countProblem && countProblem !== 'empty'
                    ? i18n.t(STOCKTAKE_COUNT_MESSAGE[countProblem])
                    : null
                }
              >
                <Input
                  type="number"
                  formatError="none"
                  value={draftTarget}
                  onChange={(e) => setDraftTarget(e.target.value)}
                  autoFocus
                />
                {/* Walkthrough F24 (2026-11-05): "the system works out the
                      difference" — now it is shown before saving. */}
                {countProblem === null && draftTarget.trim() !== ''
                  ? (() => {
                      const diff = stocktakeDiff(draftTarget, action.current, readDecimalText);
                      if (diff === null) return null;
                      const unit = skuById.get(action.skuId)?.unit ?? '';
                      const negative = diff.startsWith('-');
                      const abs = negative ? diff.slice(1) : diff;
                      return (
                        <span
                          className={`mt-1 block text-old-label tabular-nums ${
                            diff === '0' ? 'text-[var(--c-fg-muted)]' : 'text-[var(--c-fg)]'
                          }`}
                        >
                          {diff === '0'
                            ? i18n.t('inventory.sheet.stocktake.noDiff')
                            : i18n.t('inventory.sheet.stocktake.diff', {
                                diff: `${negative ? '−' : '+'}${formatQty(abs)} ${unitLabel(unit, abs)}`.trim(),
                              })}
                        </span>
                      );
                    })()
                  : null}
              </Field>
              <Field label={i18n.t('inventory.sheet.note')}>
                <Input
                  value={draftNote}
                  maxLength={INVENTORY_NOTE_MAX}
                  aria-label={i18n.t('inventory.sheet.note')}
                  onChange={(e) => setDraftNote(e.target.value)}
                  placeholder={i18n.t('inventory.sheet.stocktake.notePlaceholder')}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label={i18n.t('inventory.sheet.wastage.qtyLabel')}>
                <Input
                  type="number"
                  aria-label={i18n.t('inventory.sheet.wastage.qtyLabel')}
                  value={draftWasteQty}
                  onChange={(e) => setDraftWasteQty(e.target.value)}
                  autoFocus
                />
              </Field>
              <Field
                label={i18n.t('inventory.sheet.note')}
                hint={i18n.t('inventory.sheet.wastage.noteHint')}
              >
                <Input
                  value={draftNote}
                  maxLength={INVENTORY_NOTE_MAX}
                  aria-label={i18n.t('inventory.sheet.note')}
                  onChange={(e) => setDraftNote(e.target.value)}
                  placeholder={i18n.t('inventory.sheet.wastage.notePlaceholder')}
                />
              </Field>
            </>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
