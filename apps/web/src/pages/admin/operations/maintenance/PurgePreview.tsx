/**
 * What a purge would delete, shared by the targeted purge browser and the
 * day and workspace resets. Review ADM2-10 (2026-11-11): its own file
 * when the Operations sections split.
 */
import type { ReactNode } from 'react';
import { Card } from '@compass/ui';
import { purgeCountsByKind } from '@compass/contracts/limits';
import { useI18n } from '../../../../hooks/useI18n';

/**
 * What a purge would delete: a headline, then the counts by kind. Review
 * ADM2-12 (2026-11-11): the order, run, day and full purges each drew this
 * box themselves, two of them as grey cards (UI-13: grey is for inputs).
 */
export function PurgePreview({
  title,
  byTable,
  children,
}: {
  title: string;
  /** Left out when there is nothing to delete. */
  byTable?: Record<string, number>;
  children?: ReactNode;
}) {
  return (
    <Card className="p-3">
      <div className="text-old-body font-semibold text-[var(--c-fg)]">{title}</div>
      {byTable ? <PurgeCountList byTable={byTable} /> : null}
      {children}
    </Card>
  );
}

/** CMP-OPS-6: what a purge deletes, in plain words, with counts. */
function PurgeCountList({ byTable }: { byTable: Record<string, number> }) {
  const i18n = useI18n();
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {purgeCountsByKind(byTable).map(({ kind, n }) => (
        <li key={kind} className="flex justify-between text-old-label text-[var(--c-fg-muted)]">
          <span className="truncate">{i18n.t(`ops.purge.kind.${kind}`)}</span>
          <span className="tabular-nums">{n}</span>
        </li>
      ))}
    </ul>
  );
}
