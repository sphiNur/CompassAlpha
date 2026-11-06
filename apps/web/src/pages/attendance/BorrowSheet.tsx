/**
 * Clock a colleague in on this phone (owner request 2026-11-06: a
 * forgotten or broken phone is no excuse). Same store only. The colleague
 * takes their own face and liveness frames here; the server matches them
 * with the face registered for them, and the managers and the colleague
 * are told it happened on this phone.
 */
import { Button, DataState, EmptyState, Sheet } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { trpc } from '../../lib/trpc';

type Colleague = {
  memberId: string;
  name: string;
  faceOnFile: boolean;
  nextKind: 'in' | 'out';
};

export function BorrowSheet({
  open,
  storeId,
  onClose,
  onPick,
}: {
  open: boolean;
  storeId: string;
  onClose: () => void;
  onPick: (colleague: Colleague) => void;
}) {
  const i18n = useI18n();
  const list = trpc.attendance.colleagues.useQuery({ storeId }, { enabled: open });
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={i18n.t('attendance.borrow.title')}
      description={i18n.t('attendance.borrow.hint')}
    >
      <div className="flex flex-col gap-2 py-3">
        <DataState query={list}>
          {(data) =>
            data.members.length === 0 ? (
              <EmptyState
                title={i18n.t('attendance.borrow.emptyTitle')}
                description={i18n.t('attendance.borrow.emptyBody')}
              />
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--c-divider)]">
                {data.members.map((m) => (
                  <li key={m.memberId} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-old-body font-semibold text-[var(--c-fg)]">
                        {m.name}
                      </p>
                      {!m.faceOnFile ? (
                        <p className="text-old-label text-[var(--c-fg-muted)]">
                          {i18n.t('attendance.borrow.noFace')}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant={m.nextKind === 'in' ? 'primary' : 'secondary'}
                      disabled={!m.faceOnFile}
                      onClick={() => onPick(m)}
                    >
                      {i18n.t(m.nextKind === 'in' ? 'attendance.clock.in' : 'attendance.clock.out')}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          }
        </DataState>
      </div>
    </Sheet>
  );
}
