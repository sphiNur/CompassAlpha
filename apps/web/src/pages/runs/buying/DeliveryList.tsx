import { useMemo } from 'react';
import { Button, EmptyState, List, Row, Section, StatusChip } from '@compass/ui/kit';
import type { StatusTone } from '@compass/ui/kit';
import type { useI18n } from '../../../hooks/useI18n';
import type { ActiveRun } from '../types';

type I18n = ReturnType<typeof useI18n>;
type Stage = 'pending' | 'delivered' | 'confirmed';

const TONE: Record<Stage, StatusTone> = {
  pending: 'neutral',
  delivered: 'pending',
  confirmed: 'done',
};

export interface DeliveryListProps {
  run: ActiveRun;
  storeById: Map<string, { name: string }>;
  i18n: I18n;
  onDeliver: (storeId: string) => void;
  /** The store whose "delivered" is being saved right now. */
  deliveringStoreId: string | null;
  onRecall: (storeId: string, storeName: string) => void;
}

/**
 * The stores of a trip and how far each has got: not delivered, waiting
 * for the store to check it in, checked in.
 *
 * A trip usually goes to three or four stores, so handing over is one
 * tap on the store's own button with no confirmation. A delivered store
 * opens to take the delivery back, until the store has checked its goods
 * in; after that the row is settled and no longer opens.
 */
export function DeliveryList({
  run,
  storeById,
  i18n,
  onDeliver,
  deliveringStoreId,
  onRecall,
}: DeliveryListProps) {
  // Grouped once: a trip is some 260 lines over a handful of stores, and
  // the six-second refresh hands back new arrays every time.
  const stores = useMemo(() => {
    const byStore = new Map<string, { lines: number; delivered: boolean; confirmed: boolean }>();
    for (const sp of run.splits) {
      const store = byStore.get(sp.storeId) ?? { lines: 0, delivered: true, confirmed: true };
      store.lines += 1;
      store.delivered &&= !!sp.deliveredAt;
      store.confirmed &&= !!sp.confirmedAt;
      byStore.set(sp.storeId, store);
    }
    return [...byStore.entries()].map(([storeId, s]) => ({
      storeId,
      lines: s.lines,
      stage: (s.confirmed ? 'confirmed' : s.delivered ? 'delivered' : 'pending') as Stage,
    }));
  }, [run.splits]);

  // Nothing could be bought, so there is nothing to carry anywhere. The
  // run can still be finished, and the screen says so rather than going blank.
  if (stores.length === 0) {
    return (
      <EmptyState
        title={i18n.t('run.empty.nothingToDeliver') as string}
        hint={i18n.t('run.empty.nothingToDeliverBody') as string}
        action={null}
      />
    );
  }

  return (
    <Section
      title={i18n.t('run.section.stores') as string}
      summary={
        <span className="text-body text-secondary">
          {i18n.t('run.label.confirmedFraction', {
            done: stores.filter((s) => s.stage === 'confirmed').length,
            total: stores.length,
          })}
        </span>
      }
    >
      <List>
        {stores.map(({ storeId, lines, stage }) => {
          const name = storeById.get(storeId)?.name ?? storeId.slice(0, 8);
          return (
            <Row
              key={storeId}
              data-testid="delivery-row"
              title={name}
              detail={i18n.t('run.label.itemsCount', { n: lines })}
              value={
                stage === 'pending' ? undefined : (
                  <StatusChip tone={TONE[stage]}>
                    {i18n.t(`run.deliveryStage.${stage}` as Parameters<I18n['t']>[0])}
                  </StatusChip>
                )
              }
              onPress={stage === 'delivered' ? () => onRecall(storeId, name) : undefined}
              trailing={
                stage === 'pending' ? (
                  <Button
                    inline
                    data-testid="deliver-store"
                    busy={deliveringStoreId === storeId}
                    aria-label={i18n.t('buy.deliveredAria', { store: name }) as string}
                    onClick={() => onDeliver(storeId)}
                  >
                    {i18n.t('buy.delivered')}
                  </Button>
                ) : undefined
              }
            />
          );
        })}
      </List>
    </Section>
  );
}
