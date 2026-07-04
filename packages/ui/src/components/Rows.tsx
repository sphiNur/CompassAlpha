import type { ReactNode } from 'react';
import { cn } from '../cn';
import { surfaceClass } from './Card';
import { IconChevronRight } from './NavIcon';

/**
 * iOS-settings drill-down row. Used as a top-level entry in the Admin
 * page (and now reusable elsewhere): icon + label + optional hint +
 * chevron, tap-to-drill-down.
 *
 * Promoted from `AdminPage.SectionRow` so other pages can use the same
 * shape without re-implementing styling.
 */
export interface SectionRowProps {
  icon: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  tone?: 'normal' | 'warn' | 'danger';
  onClick: () => void;
  className?: string;
}

export function SectionRow({
  icon,
  label,
  hint,
  tone = 'normal',
  onClick,
  className,
}: SectionRowProps) {
  const iconColor =
    tone === 'warn'
      ? 'text-[var(--c-warning)]'
      : tone === 'danger'
        ? 'text-[var(--c-danger)]'
        : 'text-[var(--c-action)]';
  return (
    <li className={className}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'press flex w-full items-center gap-3 px-4 py-2.5 text-left',
          surfaceClass,
        )}
      >
        <span className={cn('shrink-0', iconColor)}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-h3 font-semibold text-[var(--c-fg)]">{label}</span>
          {hint ? (
            <span className="mt-0.5 block text-label text-[var(--c-fg-muted)]">{hint}</span>
          ) : null}
        </span>
        <span aria-hidden className="shrink-0 text-[var(--c-fg-subtle)]">
          <IconChevronRight size={18} />
        </span>
      </button>
    </li>
  );
}

/**
 * One row in a list of items (CRUD lists like SKUs, suppliers, members).
 * Lighter than SectionRow — no top-level icon required, optional badge
 * slot for status (active/archived), still has a chevron when tappable.
 */
export interface ListRowProps {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  badge?: ReactNode;
  /**
   * Trailing action slot — a Button or menu affordance rendered on the
   * right, before the chevron. Kills the hand-rolled action-strip rows
   * (catalog item, member, store, sale) that each re-built this shape.
   * NOTE: a `trailing` interactive element inside an `onClick` row nests
   * a button in a button — for rows with their own actions, use the
   * read-only variant (omit `onClick`) so the row is a `<div>`.
   */
  trailing?: ReactNode;
  onClick?: () => void;
  /** Hide the chevron when row is read-only. */
  noChevron?: boolean;
  className?: string;
}

export function ListRow({
  icon,
  label,
  hint,
  badge,
  trailing,
  onClick,
  noChevron,
  className,
}: ListRowProps) {
  const inner = (
    <>
      {icon ? <span className="shrink-0 text-[var(--c-action)]">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-h3 font-semibold text-[var(--c-fg)]">{label}</span>
        {hint ? (
          <span className="mt-0.5 block truncate text-label text-[var(--c-fg-muted)]">{hint}</span>
        ) : null}
      </span>
      {badge ? <span className="shrink-0">{badge}</span> : null}
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
      {onClick && !noChevron ? (
        <span aria-hidden className="shrink-0 text-[var(--c-fg-subtle)]">
          <IconChevronRight size={16} />
        </span>
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn('press flex w-full items-center gap-3 px-4 py-2.5 text-left', surfaceClass, className)}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={cn('flex w-full items-center gap-3 px-4 py-2.5', surfaceClass, className)}>
      {inner}
    </div>
  );
}

/**
 * Two-column "label : value" row used inside detail cards (Workspace
 * info, run summary, etc.). Replaces inline copies in AdminPage and
 * RunPage.
 */
export interface DetailRowProps {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  className?: string;
}

export function DetailRow({ label, value, mono, className }: DetailRowProps) {
  return (
    <div className={cn('flex min-w-0 items-baseline justify-between gap-3', className)}>
      <span className="min-w-0 text-body-sm text-[var(--c-fg-muted)]">{label}</span>
      <span
        className={cn(
          'min-w-0 truncate text-right text-body text-[var(--c-fg)]',
          mono && 'font-mono',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * KPI tile — used in Activity dashboard. Number on top, label below.
 * `accent="warn"` flips the number to warning color when value > 0
 * (e.g. "7 pending approvals" should attract attention).
 */
export interface TileProps {
  label: ReactNode;
  value: number | string;
  accent?: 'muted' | 'warn' | 'success';
  className?: string;
}

export function Tile({ label, value, accent = 'muted', className }: TileProps) {
  const numeric = typeof value === 'number';
  const isAlerting = numeric && accent === 'warn' && (value as number) > 0;
  const valueColor =
    isAlerting
      ? 'text-[var(--c-warning)]'
      : accent === 'success'
        ? 'text-[var(--c-success)]'
        : 'text-[var(--c-fg)]';
  return (
    <div className={cn(surfaceClass, 'p-4', className)}>
      <div className="text-label font-medium uppercase tracking-[0.08em] text-[var(--c-fg-muted)]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 text-display font-semibold leading-tight tabular-nums',
          valueColor,
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Form field: 12px uppercase label + slot for the input. Replaces
 * inline `<label>` blocks in admin sheets, purchase sheets, etc. Pair
 * with `<Input>` / `<NumberInput>` / `<select>`.
 */
export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Field({ label, hint, children, className }: FieldProps) {
  return (
    <label className={cn('block', className)}>
      <FieldLabel>{label}</FieldLabel>
      <div className="mt-1">{children}</div>
      {hint ? (
        <span className="mt-1 block text-label text-[var(--c-fg-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}

/**
 * Field label — the one definition of a form-field label (sentence
 * case, `text-label font-semibold text-fg-muted`). Field uses it; call
 * sites that re-inlined the same span (e.g. ConfirmSheet's reason
 * label) should adopt it so "how a field label looks" lives in one
 * place. Deliberately sentence-case: uppercase eyebrows are
 * `SectionLabel`, a different role.
 */
export function FieldLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn('block text-label font-semibold text-[var(--c-fg-muted)]', className)}>
      {children}
    </span>
  );
}

/**
 * PickerRow — one selectable row in an inline picker (language, store,
 * secondary-language…). A tap sets `selected`; the selected row fills
 * with the action color and shows a check.
 *
 * Replaces the 5 hand-rolled copies (SettingsSheet ×3, LanguageSheet,
 * StoreSwitcher's private SwitcherRow) that had drifted on background
 * (surface vs surface-2) and truncation. Convention: rows are
 * `bg-surface` and sit INSIDE a `bg-surface-2 p-2 ring-hairline`
 * container, so the wrapper lifts the group and each row reads as a
 * card on it. Don't place PickerRow directly on a bare `surface` sheet
 * (it'd blend) — wrap it.
 */
export interface PickerRowProps {
  label: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}

export function PickerRow({ label, hint, selected, disabled, onClick, className }: PickerRowProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-left',
        selected
          ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
          : 'bg-[var(--c-surface)] text-[var(--c-fg)] active:opacity-80',
        disabled && 'opacity-60 pointer-events-none',
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-body font-semibold">{label}</span>
        {hint ? (
          <span
            className={cn(
              'mt-0.5 block truncate text-label',
              selected ? 'opacity-80' : 'text-[var(--c-fg-muted)]',
            )}
          >
            {hint}
          </span>
        ) : null}
      </span>
      {selected ? (
        <span aria-hidden className="shrink-0">
          ✓
        </span>
      ) : null}
    </button>
  );
}

/**
 * NameCell — a bilingual product/entity name: the primary-locale name
 * on one line, the secondary-locale name as a muted second line (UI-4:
 * never `primary (secondary)` inline). Replaces the div-based (Order)
 * and span-based (Confirm) hand-rolled copies that rendered the SAME
 * name two incompatible ways.
 *
 * `size` encodes the two deliberate tiers (owner decision, 2026-07-05):
 *   - 'prominent' — text-h2 (15px). Browse/pick surfaces (OrderPage)
 *     where the name is the primary thing the user scans (M3.55).
 *   - 'default'   — text-body (13px). Dense/money surfaces (Confirm,
 *     Run) where more rows per screen matters (M2.2).
 * The secondary line is text-label muted in both tiers.
 */
export interface NameCellProps {
  primary: ReactNode;
  secondary?: ReactNode;
  size?: 'default' | 'prominent';
  className?: string;
}

export function NameCell({ primary, secondary, size = 'default', className }: NameCellProps) {
  return (
    <div className={cn('min-w-0', className)}>
      <div
        className={cn(
          'truncate font-semibold leading-tight text-[var(--c-fg)]',
          size === 'prominent' ? 'text-h2' : 'text-body',
        )}
      >
        {primary}
      </div>
      {secondary ? (
        <div className="truncate text-label font-normal leading-tight text-[var(--c-fg-subtle)]">
          {secondary}
        </div>
      ) : null}
    </div>
  );
}
