import { useState } from 'react';
import {
  Button,
  ChoiceGroup,
  List,
  Money,
  PaymentChip,
  Row,
  Section,
  Sheet,
  StatusChip,
} from '@compass/ui/kit';
import type { StatusTone } from '@compass/ui/kit';
import { useAuthStore } from '../../../stores/authStore';
import type { useI18n } from '../../../hooks/useI18n';
import { useUnitLabel } from '../../../hooks/useI18n';
import { formatMoney, formatQty } from '../../../lib/format';
import type { ActiveRun } from '../types';

type I18n = ReturnType<typeof useI18n>;
type ExtraStatus = 'pending' | 'bought' | 'unavailable';
type Extra = NonNullable<ActiveRun['sessionExtrasByStore']>[string][number];

const TONE: Record<ExtraStatus, StatusTone> = {
  pending: 'pending',
  bought: 'done',
  unavailable: 'problem',
};

export interface RequestedExtrasProps {
  extrasByStore: ActiveRun['sessionExtrasByStore'];
  notesByStore: ActiveRun['sessionNotesByStore'];
  storeById: Map<string, { name: string }>;
  i18n: I18n;
  /** The run is being bought for right now, by this person. */
  editable: boolean;
  onMarkStatus: (sessionId: string, extraIndex: number, status: ExtraStatus) => void;
  /** Record what the thing cost, as other spending for that store. */
  onRecordPrice: (
    storeId: string,
    extra: { name: string; qty: string; unit: string; note?: string },
  ) => void;
}

/**
 * Things a store asked for that are not in the catalogue, in the words
 * they typed. They have no price history and no stall, so they sit
 * apart from the buying list; each says which store wants it and whether
 * it has been dealt with.
 */
export function RequestedExtras({
  extrasByStore,
  notesByStore,
  storeById,
  i18n,
  editable,
  onMarkStatus,
  onRecordPrice,
}: RequestedExtrasProps) {
  const unitLabel = useUnitLabel();
  const [open, setOpen] = useState<{ storeId: string; index: number } | null>(null);
  const storeName = (id: string): string => storeById.get(id)?.name ?? id.slice(0, 8);
  const statusLabel = (status: ExtraStatus): string =>
    i18n.t(`run.extras.status.${status}` as Parameters<I18n['t']>[0]) as string;

  const stores = [
    ...new Set([...Object.keys(extrasByStore ?? {}), ...Object.keys(notesByStore ?? {})]),
  ];
  const rows = stores.flatMap((storeId) =>
    (extrasByStore?.[storeId] ?? []).map((extra, index) => ({ storeId, extra, index })),
  );
  const notes = stores
    .map((storeId) => ({ storeId, note: (notesByStore?.[storeId] ?? '').trim() }))
    .filter((n) => n.note.length > 0);
  if (rows.length === 0 && notes.length === 0) return null;

  const opened: { storeId: string; extra: Extra } | null = (() => {
    if (!open) return null;
    const extra = extrasByStore?.[open.storeId]?.[open.index];
    return extra ? { storeId: open.storeId, extra } : null;
  })();
  const canMark = (extra: Extra): boolean =>
    editable && typeof extra.sessionId === 'string' && typeof extra.idx === 'number';

  return (
    <Section title={i18n.t('order.extras.label') as string}>
      <List>
        {rows.map(({ storeId, extra, index }) => {
          const status = extra.status ?? 'pending';
          const detail = [`${extra.qty} ${unitLabel(extra.unit)}`, storeName(storeId), extra.note]
            .filter(Boolean)
            .join(' · ');
          return (
            <Row
              key={`${extra.sessionId ?? storeId}-${extra.idx ?? index}`}
              data-testid="extra-row"
              title={extra.name}
              detail={detail}
              value={<StatusChip tone={TONE[status]}>{statusLabel(status)}</StatusChip>}
              onPress={editable ? () => setOpen({ storeId, index }) : undefined}
            />
          );
        })}
        {/* Older orders carried one free-text note instead of lines. */}
        {notes.map(({ storeId, note }) => (
          <Row
            key={`note-${storeId}`}
            title={storeName(storeId)}
            detail={<span className="whitespace-pre-wrap">{note}</span>}
          />
        ))}
      </List>

      {opened ? (
        <Sheet
          open
          onOpenChange={(next) => !next && setOpen(null)}
          title={opened.extra.name}
          actions={
            <Button
              variant="primary"
              onClick={() => {
                setOpen(null);
                onRecordPrice(opened.storeId, opened.extra);
              }}
            >
              {i18n.t('run.price.fillIn')}
            </Button>
          }
        >
          <div className="flex flex-col gap-lg">
            <p className="text-body text-secondary">
              {[
                `${opened.extra.qty} ${unitLabel(opened.extra.unit)}`,
                storeName(opened.storeId),
                opened.extra.note,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {canMark(opened.extra) ? (
              <ChoiceGroup<ExtraStatus>
                label={i18n.t('buy.extraStatus') as string}
                value={opened.extra.status ?? 'pending'}
                onChange={(next) =>
                  onMarkStatus(opened.extra.sessionId!, opened.extra.idx!, next)
                }
                options={(['pending', 'bought', 'unavailable'] as const).map((value) => ({
                  value,
                  label: statusLabel(value),
                }))}
              />
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </Section>
  );
}

export interface OtherSpendingProps {
  expenses: ActiveRun['expenses'];
  storeById: Map<string, { name: string }>;
  i18n: I18n;
  editable: boolean;
  onRemove: (expenseId: string) => void;
}

/**
 * Money spent on the trip that is not a product line: a porter, bags, a
 * thing bought off the list. Same row as a bought line, because it is
 * the same fact: what, how much, and how it was paid.
 */
export function OtherSpending({ expenses, storeById, i18n, editable, onRemove }: OtherSpendingProps) {
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const [removing, setRemoving] = useState<string | null>(null);
  const list = expenses ?? [];
  if (list.length === 0) return null;
  const lineOf = (e: (typeof list)[number]): number => Number(e.qty) * Number(e.unitPrice);
  const toRemove = removing ? list.find((e) => e.id === removing) : undefined;

  return (
    <Section
      title={i18n.t('buy.otherSpending') as string}
      summary={
        <Money amount={formatMoney(list.reduce((sum, e) => sum + lineOf(e), 0))} currency={currency} />
      }
    >
      <List>
        {list.map((e) => {
          const stores = e.storeSplits
            .map((sp) => storeById.get(sp.storeId)?.name ?? sp.storeId.slice(0, 8))
            .join(', ');
          const detail = [
            `${formatQty(e.qty)}${e.unitHint ? ` ${e.unitHint}` : ''} × ${formatMoney(e.unitPrice)}`,
            stores,
            e.reason,
          ]
            .filter(Boolean)
            .join(' · ');
          const transfer = e.paymentMethod === 'transfer';
          return (
            <Row
              key={e.id}
              data-testid="spending-row"
              title={e.label}
              detail={detail}
              value={<Money amount={formatMoney(lineOf(e))} />}
              valueNote={
                <PaymentChip
                  method={transfer ? 'transfer' : 'cash'}
                  label={
                    i18n.t(
                      transfer ? 'run.label.paymentTransfer' : 'run.label.paymentCash',
                    ) as string
                  }
                />
              }
              onPress={editable ? () => setRemoving(e.id) : undefined}
            />
          );
        })}
      </List>

      {toRemove ? (
        <Sheet
          open
          onOpenChange={(next) => !next && setRemoving(null)}
          title={i18n.t('buy.removeSpending', { name: toRemove.label }) as string}
          actions={
            <>
              <Button
                variant="danger"
                onClick={() => {
                  setRemoving(null);
                  onRemove(toRemove.id);
                }}
              >
                {i18n.t('common.remove')}
              </Button>
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                {i18n.t('common.cancel')}
              </Button>
            </>
          }
        >
          <div className="flex items-baseline justify-between gap-lg">
            <span className="text-body text-secondary">
              {`${formatQty(toRemove.qty)} × ${formatMoney(toRemove.unitPrice)}`}
            </span>
            <Money amount={formatMoney(lineOf(toRemove))} currency={currency} size="lg" />
          </div>
        </Sheet>
      ) : null}
    </Section>
  );
}
