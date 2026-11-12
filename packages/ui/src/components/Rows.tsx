import { useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../cn';
import { useUiLabels } from '../labels';
import { surfaceClass } from './Card';
import { FieldError } from './FieldError';
import { FieldControlContext, joinIds, type FieldControl } from './fieldControl';
import { IconChevronRight } from './NavIcon';
import { useRovingRadio } from '../rovingRadio';

/**
 * iOS-settings drill-down row. Used as a top-level entry in the Admin
 * page (and now reusable elsewhere): icon + label + optional hint +
 * chevron, tap-to-drill-down.
 *
 * Promoted from `AdminPage.SectionRow` so other pages can use the same
 * shape without re-implementing styling.
 */
export interface SectionRowProps {
  /** Optional — a menu of like rows sharing one repeated icon carries
   *  no information; omit it and the row renders text-only (UIUX-B1). */
  icon?: ReactNode;
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
      ? 'text-[var(--c-warning-fg)]'
      : tone === 'danger'
        ? 'text-[var(--c-danger)]'
        : 'text-[var(--c-action)]';
  return (
    <li className={className}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'press flex w-full items-center gap-3 px-4 py-3 text-left',
        )}
      >
        {icon ? <span className={cn('shrink-0', iconColor)}>{icon}</span> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-old-h3 font-semibold text-[var(--c-fg)]">{label}</span>
          {hint ? (
            <span className="mt-0.5 block text-old-label text-[var(--c-fg-muted)]">{hint}</span>
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
        <span className="block truncate text-old-h3 font-semibold text-[var(--c-fg)]">{label}</span>
        {hint ? (
          <span className="mt-0.5 block truncate text-old-label text-[var(--c-fg-muted)]">{hint}</span>
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
        className={cn('press flex w-full items-center gap-3 px-4 py-3 text-left', className)}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={cn('flex w-full items-center gap-3 px-4 py-3', className)}>
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
  className?: string;
}

export function DetailRow({ label, value, className }: DetailRowProps) {
  return (
    <div className={cn('flex min-w-0 items-baseline justify-between gap-3', className)}>
      <span className="min-w-0 text-old-body-sm text-[var(--c-fg-muted)]">{label}</span>
      <span className="min-w-0 truncate text-right text-old-body text-[var(--c-fg)]">{value}</span>
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
      ? 'text-[var(--c-warning-fg)]'
      : accent === 'success'
        ? 'text-[var(--c-success)]'
        : 'text-[var(--c-fg)]';
  return (
    <div className={cn(surfaceClass, 'p-4', className)}>
      <div className="text-old-body-sm font-medium text-[var(--c-fg-muted)]">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 text-old-display font-semibold leading-tight tabular-nums',
          valueColor,
        )}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Form field: the label, the control, then why its value is refused and
 * a hint. Pair with the kit's `<Input>` (also `type="number"`),
 * `<Select>`, `<Textarea>` or `<PickerButton>`; several controls under
 * one title are a FieldGroup.
 *
 * Review UI-02 (2026-11-11): `error` and `required` live here, and the
 * control is tied to the error and hint lines (aria-describedby,
 * aria-invalid, aria-required) through FieldControlContext. Pages used
 * to wire ids by hand or put the error inside the `<label>`, which made
 * it part of the field's name. A number field's "not one number" line
 * shows in the same place as `error`; a page's own `error` wins.
 *
 * Review UI-01 (2026-11-12): the label is a `<label for>` naming the
 * control by the id the Field gives it. It used to wrap the content, so
 * it named whatever control came first (a Save button beside the input
 * was inside the label too), and a `<label>` may not hold a `<div>`.
 */
export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Why the value is refused, under the control; nothing when empty. */
  error?: ReactNode;
  /** Marks the label (a "*" a screen reader skips) and the control. */
  required?: boolean;
  children: ReactNode;
  className?: string;
}

const shown = (node: ReactNode) =>
  node !== undefined && node !== null && node !== false && node !== '';

export function Field({ label, hint, error, required = false, children, className }: FieldProps) {
  const labels = useUiLabels();
  const controlId = useId();
  const labelId = useId();
  const errorId = useId();
  const hintId = useId();
  const [badFormat, setBadFormat] = useState<ReadonlySet<string>>(() => new Set());
  const reportFormatError = useCallback((controlId: string, isShown: boolean) => {
    setBadFormat((prev) => {
      if (prev.has(controlId) === isShown) return prev;
      const next = new Set(prev);
      if (isShown) next.add(controlId);
      else next.delete(controlId);
      return next;
    });
  }, []);
  const hasError = shown(error);
  const message = hasError ? error : badFormat.size > 0 ? labels.numberInvalid : null;
  const hasMessage = message !== null;
  const hasHint = shown(hint);
  // Booleans and ids only: `error` and `hint` are new elements on every
  // render and would redraw each control in the field.
  const control = useMemo<FieldControl>(
    () => ({
      id: controlId,
      labelId,
      describedBy: joinIds(hasMessage && errorId, hasHint && hintId),
      invalid: hasError,
      required,
      reportFormatError,
    }),
    [
      controlId,
      labelId,
      hasMessage,
      errorId,
      hasHint,
      hintId,
      hasError,
      required,
      reportFormatError,
    ],
  );
  return (
    <div className={cn('block', className)}>
      <FieldLabel id={labelId} htmlFor={controlId} required={required}>
        {label}
      </FieldLabel>
      <FieldControlContext.Provider value={control}>
        <div className="mt-1">{children}</div>
      </FieldControlContext.Provider>
      {hasMessage ? <FieldError id={errorId}>{message}</FieldError> : null}
      {hasHint ? (
        <span id={hintId} className="mt-1 block text-old-label text-[var(--c-fg-muted)]">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A titled set of controls (checkboxes, a segmented choice, a switch
 * with its own label), drawn like Field.
 *
 * UI-01 (2026-11-09): Field wrapped its content in a `<label>`, which
 * handed a click on the title, or on the gaps of a list, to the first
 * control inside. Tapping "Assigned stores" ticked the first store and
 * assigned the member there. A label may not hold another label either.
 * A group is titled, not labelled: use Field for one control, FieldGroup
 * for several.
 */
/** A group has no aria-required; a required choice says so in its label. */
export type FieldGroupProps = Omit<FieldProps, 'required'>;

export function FieldGroup({ label, hint, error, children, className }: FieldGroupProps) {
  const titleId = useId();
  const errorId = useId();
  const hintId = useId();
  const hasError = shown(error);
  const hasHint = shown(hint);
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={joinIds(hasError && errorId, hasHint && hintId)}
      className={cn('block', className)}
    >
      <FieldLabel id={titleId}>{label}</FieldLabel>
      <div className="mt-1">{children}</div>
      {hasError ? <FieldError id={errorId}>{error}</FieldError> : null}
      {hasHint ? (
        <span id={hintId} className="mt-1 block text-old-label text-[var(--c-fg-muted)]">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Field label — the one definition of a form-field label (sentence
 * case, `text-old-label font-semibold text-fg-muted`): Field, FieldGroup
 * and PhotoCapture draw theirs with it. A section heading is
 * `SectionLabel`, a different role (both sentence case, UI-11).
 *
 * With `htmlFor` it is the `<label>` of that control (Field's, UI-01);
 * without, a title the caller ties to its content by `id`.
 */
export function FieldLabel({
  className,
  children,
  id,
  htmlFor,
  required = false,
}: {
  className?: string;
  children: ReactNode;
  id?: string;
  htmlFor?: string;
  /** Draws the "*". The control says it is required (aria-required). */
  required?: boolean;
}) {
  const look = cn('block text-old-label font-semibold text-[var(--c-fg-muted)]', className);
  const text = required ? (
    <>
      {children}
      <span aria-hidden> *</span>
    </>
  ) : (
    children
  );
  return htmlFor ? (
    <label id={id} htmlFor={htmlFor} className={look}>
      {text}
    </label>
  ) : (
    <span id={id} className={look}>
      {text}
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
  /** A11Y-3: the label's language when it is not the page's (「Русский」). */
  lang?: string;
}

/**
 * A11Y-15 (2026-10-31): a PickerRow is one choice of several, so it is a
 * radio (it said `aria-pressed`, a toggle) and its container is a
 * {@link PickerGroup} radiogroup with arrow-key movement. Arrows only move
 * focus here; Space / Enter chooses, because choosing a language or a
 * workspace sends a request.
 */
export function PickerRow({
  label,
  hint,
  selected,
  disabled,
  onClick,
  className,
  lang,
}: PickerRowProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      role="radio"
      aria-checked={!!selected}
      tabIndex={selected ? 0 : -1}
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
        <span lang={lang} className="block truncate text-old-body font-semibold">
          {label}
        </span>
        {hint ? (
          <span
            className={cn(
              'mt-0.5 block truncate text-old-label',
              // Full-strength ink on the selected fill: at opacity-80 the hint
              // measured 3.92:1 on --c-action (axe, 2026-10-31).
              selected ? undefined : 'text-[var(--c-fg-muted)]',
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
 * The container of a set of {@link PickerRow}s: the `bg-surface-2 p-2
 * ring-hairline` panel every picker used, now also the radiogroup that
 * names the choice and moves between rows with the arrow keys.
 */
export function PickerGroup({
  label,
  children,
  className,
}: {
  /** What is being chosen, e.g. "Language". */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const roving = useRovingRadio<HTMLDivElement>({ followFocus: false });
  return (
    <div
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
      role="radiogroup"
      aria-label={label}
      className={cn(
        'flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-2 ring-hairline',
        className,
      )}
    >
      {children}
    </div>
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
 *   - 'prominent' — text-old-h2 (15px). Browse/pick surfaces (OrderPage)
 *     where the name is the primary thing the user scans (M3.55).
 *   - 'default'   — text-old-body (13px). Dense/money surfaces (Confirm,
 *     Run) where more rows per screen matters (M2.2).
 * The secondary line is text-old-label muted in both tiers.
 */
export interface NameCellProps {
  primary: ReactNode;
  secondary?: ReactNode;
  /**
   * A11Y-3 (2026-10-31): the language each name is written in, when it is
   * not the page's. A screen reader then reads «Говядина» with a Russian
   * voice instead of spelling it out in Chinese.
   */
  primaryLang?: string;
  secondaryLang?: string;
  size?: 'default' | 'prominent';
  /**
   * 'span' inside a button, where only phrasing content may go (review
   * RUNWEB2-06, the run's product picker). It looks the same.
   */
  as?: 'div' | 'span';
  className?: string;
  /**
   * Extra classes for the primary line, merged over its own: a row's
   * state (muted when done, struck through when dropped) or one line
   * only (`line-clamp-1`). RUNWEB1-09: the run's purchase rows.
   */
  primaryClassName?: string;
  /** Tooltip on the primary line, for a name a row clamps (mouse only). */
  title?: string;
}

export function NameCell({
  primary,
  secondary,
  primaryLang,
  secondaryLang,
  size = 'default',
  as: Tag = 'div',
  className,
  primaryClassName,
  title,
}: NameCellProps) {
  return (
    <Tag className={cn('block min-w-0', className)}>
      {/* No explicit leading on the primary — each tier inherits its
          size token's line-height (text-old-h2 → 1.25, text-old-body → 1.4) so
          this matches the hand-rolled markup it replaced byte-for-byte.
          The secondary line stays leading-tight (both originals did).
          A11Y-1 (2026-10-31): the primary name wraps to two lines instead
          of truncating. At 200% zoom a row is ~195 px wide and `truncate`
          cut the name down to nothing, leaving only the qty control. */}
      <Tag
        lang={primaryLang}
        title={title}
        className={cn(
          'line-clamp-2 break-words font-semibold text-[var(--c-fg)]',
          size === 'prominent' ? 'text-old-h2' : 'text-old-body',
          primaryClassName,
        )}
      >
        {primary}
      </Tag>
      {secondary ? (
        <Tag
          lang={secondaryLang}
          className="block truncate text-old-label font-normal leading-tight text-[var(--c-fg-subtle)]"
        >
          {secondary}
        </Tag>
      ) : null}
    </Tag>
  );
}
