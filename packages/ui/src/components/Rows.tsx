import type { ReactNode } from 'react';
import { cn } from '../cn';
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
        className="press flex w-full items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 text-left ring-hairline"
      >
        <span className={cn('shrink-0', iconColor)}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-h3 font-semibold text-[var(--c-fg)]">{label}</span>
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
  onClick,
  noChevron,
  className,
}: ListRowProps) {
  const inner = (
    <>
      {icon ? <span className="shrink-0 text-[var(--c-action)]">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block text-h3 font-semibold text-[var(--c-fg)]">{label}</span>
        {hint ? (
          <span className="mt-0.5 block truncate text-label text-[var(--c-fg-muted)]">{hint}</span>
        ) : null}
      </span>
      {badge ? <span className="shrink-0">{badge}</span> : null}
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
        className={cn(
          'press flex w-full items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 text-left ring-hairline',
          className,
        )}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      className={cn(
        'flex w-full items-center gap-3 rounded-[var(--r-card)] bg-[var(--c-surface)] px-4 py-3 ring-hairline',
        className,
      )}
    >
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
    <div className={cn('flex items-baseline justify-between gap-3', className)}>
      <span className="text-body-sm text-[var(--c-fg-muted)]">{label}</span>
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
    <div
      className={cn(
        'rounded-[var(--r-card)] bg-[var(--c-surface)] p-4 ring-hairline',
        className,
      )}
    >
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
      <span className="block text-label font-semibold text-[var(--c-fg-muted)]">{label}</span>
      <div className="mt-1">{children}</div>
      {hint ? (
        <span className="mt-1 block text-label text-[var(--c-fg-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}
