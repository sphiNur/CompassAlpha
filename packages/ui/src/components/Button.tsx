import { forwardRef, isValidElement, useCallback, useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';
import { Spinner } from './Spinner';
import { createTapGuard } from '../useTapGuard';
import { disabledClass } from './disabled';
import { useUiAnnounce } from '../announce';
import { useUiLabels } from '../labels';

const button = cva(
  [
    // V4 (2026-10-30): hit-44 gives sm (32 px) a 44 px tap area without
    // changing how it looks; md (44) and lg (52) are already that tall.
    // That needs the button NOT to clip its overflow (a clipped ::after
    // takes no taps); the label span below truncates itself instead.
    'press hit-44 inline-flex min-w-0 max-w-full items-center justify-center gap-2 font-medium select-none',
    // Review UI-31 (2026-11-12): transform is in the list, at .press's
    // own --t-snap / --easing. Without it this utility (later in the
    // stylesheet) replaced .press's transition, so the press shrink
    // jumped instead of easing in.
    'whitespace-nowrap outline-none transition-[background,color,box-shadow,transform]',
    'duration-[var(--t-snap)] ease-[var(--easing)]',
    'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
    'focus-visible:ring-offset-[var(--c-ring-offset)]',
    disabledClass,
    'disabled:pointer-events-none',
    // Review MWB-10 (modern-web-guidance: progress): a loading button is
    // aria-disabled, not disabled, so focus stays on it; it looks as a
    // disabled one did.
    'data-[loading]:cursor-not-allowed data-[loading]:opacity-50 data-[loading]:pointer-events-none',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--c-action)] text-[var(--c-action-fg)] hover:bg-[var(--c-action-hover)] rounded-[var(--r-pill)]',
        secondary:
          'bg-[var(--c-surface-2)] text-[var(--c-fg)] rounded-[var(--r-pill)] ring-hairline',
        ghost:
          'bg-transparent text-[var(--c-action)] rounded-[var(--r-pill)]',
        utility:
          'bg-[var(--c-fg)] text-[var(--c-fg-inverse)] rounded-[var(--r-utility)]',
        // Filled red — for irreversible PRIMARY destructive actions
        // (delete account, drop org). Heavy by design.
        danger:
          'bg-[var(--c-danger)] text-[var(--c-danger-fg)] rounded-[var(--r-pill)]',
        // M3.16 (2026-05-16): "soft danger" — transparent with red
        // text + red hairline. Right tone for SECONDARY destructive
        // operations (archive a category, archive a SKU) where the
        // PRIMARY action sitting next to it is "Edit". Filled-danger
        // was outweighing Edit in admin lists and pulling the user's
        // eye to the dangerous button.
        'danger-ghost':
          'bg-transparent text-[var(--c-danger)] rounded-[var(--r-pill)] ring-1 ring-[color:color-mix(in_oklch,var(--c-danger)_40%,transparent)]',
        pearl:
          'bg-[var(--c-surface-2)] text-[var(--c-fg)] rounded-[var(--r-capsule)] ring-hairline',
      },
      size: {
        // M2.4 (text), M3.15 (heights, 2026-05-16):
        //   - sm: h-8 (32) + text-old-label (11) — compact secondary actions.
        //   - md: --control-h (44 since D18, 2026-10-31; 40 before) +
        //     text-old-h3 (14) — default form / inline actions. Shares the
        //     text fields' height so an Input + Button row lines up.
        //   - lg: h-13 (52, was 56) + text-old-h3 (14, was text-old-h2 / 15) —
        //     sheet-footer commits + page-bottom CTAs. Big enough to
        //     anchor the action without towering over the 64 px nav.
        sm: 'h-8 px-3 text-old-label',
        md: 'h-[var(--control-h)] px-5 text-old-h3',
        // h-[52px] — Tailwind's scale jumps 12→14 (48→56), and we want
        // exactly the middle.
        lg: 'h-[52px] px-7 text-old-h3',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md', block: false },
  },
);

/** A second tap on a write button within this window is a double tap. */
export const REPEAT_TAP_MS = 700;

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  /**
   * The action's request is in flight: shows a spinner and disables the
   * button. Passing the prop at all (even `false`) also marks the button
   * as one that sends a write, so a quick second tap is dropped — see
   * REPEAT_TAP_MS.
   */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  /**
   * UX-05 (2026-11-13): why the button cannot be used yet ("Enter a
   * name."). Shown as one muted line above the button while it is disabled
   * (not while it is loading), and tied to it with aria-describedby. A
   * greyed Save with no reason left people guessing what was missing; the
   * daily close's main button does the same with `inactiveHint`.
   *
   * Passing the prop at all (even as `undefined`) wraps the button in a
   * column, so the tree keeps its shape when the hint comes and goes.
   */
  disabledHint?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(props, ref) {
  const {
    className,
    variant,
    size,
    block,
    loading,
    leadingIcon,
    trailingIcon,
    children,
    disabled,
    onClick,
    disabledHint,
    ...rest
  } = props;
  const hintId = useId();
  const childIsPlain = typeof children === 'string' || typeof children === 'number';
  const tapGuard = useRef<ReturnType<typeof createTapGuard> | null>(null);
  // DLV-4 / BUY-12 (2026-10-30): `loading` disables the button only after
  // the re-render that follows the mutation starting, and React Query
  // reports isPending on a later tick — a double tap lands both clicks
  // first. "Start delivery" then sent two requests and showed success and
  // a conflict together. Every button that carries `loading` sends a
  // write, so it drops a repeat inside the window itself instead of each
  // call site remembering to wrap its handler.
  const guarded =
    loading === undefined || !onClick
      ? onClick
      : (e: MouseEvent<HTMLButtonElement>) => {
          tapGuard.current ??= createTapGuard(REPEAT_TAP_MS);
          if (!tapGuard.current.allow('', Date.now())) {
            e.preventDefault(); // a submit button must not submit twice either
            return;
          }
          onClick(e);
        };
  // Review MWB-10 (modern-web-guidance: progress): "aria-busy has
  // inconsistent screen reader support". When the person's own press
  // starts the request, "Please wait…" is said through the host's polite
  // region. Only then: a button whose loading follows a request started
  // elsewhere says nothing.
  const announce = useUiAnnounce();
  const labels = useUiLabels();
  const pressedAt = useRef(0);
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const wasLoading = useRef(!!loading);
  useEffect(() => {
    const started = !!loading && !wasLoading.current;
    wasLoading.current = !!loading;
    if (!started) return;
    const el = ownRef.current;
    const focused = !!el && typeof document !== 'undefined' && document.activeElement === el;
    if (saysBusy(focused, pressedAt.current, Date.now())) announce(labels.busy);
  }, [loading, announce, labels]);
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      ownRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  const hint = buttonHint(disabled, loading, disabledHint);
  useHintChange(hint);
  const describedBy =
    [rest['aria-describedby'], hint ? hintId : undefined].filter(Boolean).join(' ') || undefined;
  const el = (
    <button
      ref={setRef}
      type={rest.type ?? 'button'}
      // MWB-10: while loading the button keeps focus (aria-disabled); the
      // click guard below drops presses, a form's Enter included.
      disabled={(disabled && !loading) || undefined}
      data-loading={loading || undefined}
      className={cn(button({ variant, size, block }), className)}
      {...rest}
      aria-disabled={loading || rest['aria-disabled'] || undefined}
      aria-describedby={describedBy}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (loading) {
          e.preventDefault(); // no second submit of the form either
          return;
        }
        pressedAt.current = Date.now();
        guarded?.(e);
      }}
    >
      {loading ? <Spinner size={16} /> : leadingIcon}
      <span className={childIsPlain || !isValidElement(children) ? 'min-w-0 truncate' : 'min-w-0'}>
        {children}
      </span>
      {trailingIcon}
    </button>
  );
  if (!('disabledHint' in props)) return el;
  const hintLine = hint ? (
    // Review MWA-06 (modern-web-guidance: accessible-error-announcement):
    // a plain line tied by aria-describedby. It was its own role="status"
    // region, mounted already holding its text, which is often not read.
    // A change of reason ("Photo uploading…" giving way to "Describe the
    // problem") is said through the host's region (useHintChange).
    <span
      id={hintId}
      data-testid="button-disabled-hint"
      className={cn('block text-old-label text-[var(--c-fg-muted)]', block && 'text-center')}
    >
      {hint}
    </span>
  ) : null;
  // A block button (a sheet footer's) has the line above it, as the page
  // main button does; an inline one, in a row of buttons, below it, so
  // the row's buttons stay level.
  return block ? (
    <span className="flex w-full flex-col gap-2">
      {hintLine}
      {el}
    </span>
  ) : (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      {el}
      {hintLine}
    </span>
  );
});

/**
 * The hint a Button shows: only while it is disabled and not loading (a
 * spinner already says why it cannot be tapped), and only when there is
 * something to say.
 */
export function buttonHint(
  disabled: boolean | undefined,
  loading: boolean | undefined,
  disabledHint: string | undefined,
): string | undefined {
  if (!disabled || loading) return undefined;
  return disabledHint?.trim() || undefined;
}

/**
 * Review MWB-10: whether a request that just started is said: the button
 * has focus, or was pressed in the last second (a tap on a phone does not
 * always focus a button).
 */
export function saysBusy(focused: boolean, pressedAt: number, now: number): boolean {
  return focused || (pressedAt > 0 && now - pressedAt <= 1000);
}

/**
 * Review MWA-06: whether a hint is said: only when one reason gives way
 * to another. The first one is read with the button when it is reached
 * (aria-describedby); saying it as it appears was noise when a sheet
 * opened with Save waiting.
 */
export function hintChanged(prev: string | undefined, next: string | undefined): boolean {
  return !!prev && !!next && prev !== next;
}

function useHintChange(hint: string | undefined): void {
  const announce = useUiAnnounce();
  const prev = useRef(hint);
  useEffect(() => {
    const before = prev.current;
    prev.current = hint;
    if (hint && hintChanged(before, hint)) announce(hint);
  }, [hint, announce]);
}
