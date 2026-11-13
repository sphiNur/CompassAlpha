import type { ReactNode } from 'react';
import { Checkbox } from '@compass/ui';

/** A store in a pick list: its name, then its code, muted. */
function StoreName({ store }: { store: { name: string; code?: string | null } }) {
  return (
    <>
      {store.name}
      {/* UX-23: a space between, so the accessible name reads "Central
          CENTRAL", not "CentralCENTRAL". */}
      {store.code ? (
        <>
          {' '}
          <span className="ml-1.5 text-old-label text-[var(--c-fg-muted)]">{store.code}</span>
        </>
      ) : null}
    </>
  );
}

/**
 * The stores someone is invited into, given a role in or assigned to, as
 * ticks: the kit checkbox names each store, and an action or a note may
 * sit beside it, outside its label (UI-01). Review ADM1-13 (2026-11-12):
 * the invite, grant and member sheets each drew this list themselves.
 */
export function StoreCheckList<S extends { id: string; name: string; code?: string | null }>({
  stores,
  isChecked,
  onChange,
  isDisabled,
  titleOf,
  trailing,
  empty,
}: {
  stores: readonly S[];
  isChecked: (store: S) => boolean;
  onChange: (store: S, checked: boolean) => void;
  /** A row shown but not changeable here. */
  isDisabled?: (store: S) => boolean;
  /** A row's tooltip, e.g. why it cannot be changed. */
  titleOf?: (store: S) => string | undefined;
  /** Beside a row's checkbox. */
  trailing?: (store: S) => ReactNode;
  /** Shown in the list when there is no store. */
  empty?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
      {stores.map((st) => (
        <div key={st.id} className="flex items-center gap-2 px-2" title={titleOf?.(st)}>
          <Checkbox
            className="min-w-0 flex-1"
            checked={isChecked(st)}
            disabled={isDisabled?.(st)}
            label={<StoreName store={st} />}
            onChange={(e) => onChange(st, e.target.checked)}
          />
          {trailing?.(st)}
        </div>
      ))}
      {stores.length === 0 ? empty : null}
    </div>
  );
}
