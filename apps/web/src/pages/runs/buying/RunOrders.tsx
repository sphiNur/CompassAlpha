import { useState } from 'react';
import { Button, List, Row, Sheet } from '@compass/ui/kit';
import type { useI18n } from '../../../hooks/useI18n';
import { formatQty } from '../../../lib/format';
import type { ActiveRun } from '../types';

type Session = NonNullable<ActiveRun['sessions']>[number];

export interface RunOrdersProps {
  sessions: Session[];
  storeById: Map<string, { name: string }>;
  i18n: ReturnType<typeof useI18n>;
  /** More approved orders are waiting and can join this trip. */
  waiting: number;
  attaching: boolean;
  onAttach: () => void;
  ejecting: boolean;
  onEject: (session: Session) => void;
}

/**
 * Which orders this trip is buying for. One line while buying, because
 * the purchaser rarely needs it; it opens to the orders themselves, where
 * one can be sent back to review. Orders approved after the trip started
 * are offered here, on the line that is about orders.
 */
export function RunOrders({
  sessions,
  storeById,
  i18n,
  waiting,
  attaching,
  onAttach,
  ejecting,
  onEject,
}: RunOrdersProps) {
  const [open, setOpen] = useState(false);
  if (sessions.length === 0 && waiting === 0) return null;
  const storeName = (id: string): string => storeById.get(id)?.name ?? id.slice(0, 8);
  const stores = [...new Set(sessions.map((s) => storeName(s.storeId)))].join(', ');

  return (
    <List>
      {sessions.length > 0 ? (
        <Row
          data-testid="run-orders"
          title={i18n.t('buy.orders', { n: sessions.length })}
          detail={stores}
          onPress={() => setOpen(true)}
        />
      ) : null}
      {waiting > 0 ? (
        <Row
          data-testid="run-orders-waiting"
          title={i18n.t('run.attach.banner.title', { n: waiting })}
          trailing={
            <Button inline busy={attaching} onClick={onAttach}>
              {i18n.t('buy.addOrders')}
            </Button>
          }
        />
      ) : null}

      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={i18n.t('buy.orders', { n: sessions.length }) as string}
      >
        <List>
          {sessions.map((s) => (
            <Row
              key={s.id}
              title={storeName(s.storeId)}
              detail={[
                s.submittedByDisplayName ?? i18n.t('run.sessions.unknownSubmitter'),
                i18n.t(s.extrasCount > 0 ? 'run.sessions.stats' : 'run.sessions.statsNoExtras', {
                  items: s.itemCount,
                  qty: formatQty(s.totalQty),
                  extras: s.extrasCount,
                }),
              ].join(' · ')}
              trailing={
                <Button
                  inline
                  disabled={ejecting}
                  onClick={() => {
                    // The confirmation that follows is a sheet of its own.
                    setOpen(false);
                    onEject(s);
                  }}
                >
                  {i18n.t('run.action.ejectSession')}
                </Button>
              }
            />
          ))}
        </List>
      </Sheet>
    </List>
  );
}
