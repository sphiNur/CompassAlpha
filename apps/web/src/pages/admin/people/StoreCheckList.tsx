import { useId } from 'react';
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
  reasonOf,
  trailing,
  empty,
}: {
  stores: readonly S[];
  isChecked: (store: S) => boolean;
  onChange: (store: S, checked: boolean) => void;
  /** A row shown but not changeable here. */
  isDisabled?: (store: S) => boolean;
  /** Why a row cannot be changed, shown as a muted line under it. */
  reasonOf?: (store: S) => string | undefined;
  /** Beside a row's checkbox. */
  trailing?: (store: S) => ReactNode;
  /** Shown in the list when there is no store. */
  empty?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline">
      {stores.map((st) => (
        <StoreCheckRow
          key={st.id}
          checked={isChecked(st)}
          disabled={isDisabled?.(st)}
          label={<StoreName store={st} />}
          reason={reasonOf?.(st)}
          onChange={(checked) => onChange(st, checked)}
          trailing={trailing?.(st)}
        />
      ))}
      {stores.length === 0 ? empty : null}
    </div>
  );
}

/**
 * Review MWC-12 / MWA-08 (modern-web-guidance: single-line-overflow, html):
 * "DO NOT rely on `title` alone: it is unreachable from the keyboard and
 * on touch". Why a store cannot be ticked ("not your store") was only a
 * `title` tooltip on the row, which a phone never shows. It is a muted
 * line under the row now, outside the checkbox's label (so it does not
 * dim with it or join its name), tied to the checkbox by aria-describedby.
 */
function StoreCheckRow({
  checked,
  disabled,
  label,
  reason,
  onChange,
  trailing,
}: {
  checked: boolean;
  disabled: boolean | undefined;
  label: ReactNode;
  reason: string | undefined;
  onChange: (checked: boolean) => void;
  trailing: ReactNode;
}) {
  const reasonId = useId();
  return (
    <div className="px-2">
      <div className="flex items-center gap-2">
        <Checkbox
          className="min-w-0 flex-1"
          checked={checked}
          disabled={disabled}
          label={label}
          aria-describedby={reason ? reasonId : undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
        {trailing}
      </div>
      {reason ? (
        // Under the label text: the 20px box and its 10px gap (Checkbox).
        <p
          id={reasonId}
          className="-mt-1.5 pb-1.5 pl-[30px] text-old-label text-[var(--c-fg-muted)]"
        >
          {reason}
        </p>
      ) : null}
    </div>
  );
}
