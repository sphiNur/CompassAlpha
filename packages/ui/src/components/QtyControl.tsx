import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../cn';
import { Sheet, SheetFooter } from './Sheet';
import { Button } from './Button';
import { NumberInput } from './NumberInput';

interface QtyControlProps {
  value: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
  /**
   * Tap on the middle value opens a quick-pick sheet by default. Pass
   * `onRequestManualEntry` to override — e.g. if the host page wants to
   * route through its own picker. The built-in sheet is sufficient for
   * almost all callers and ships pre-set chips appropriate to `step`.
   */
  onRequestManualEntry?: () => void;
  /** Compact variant for dense lists (e.g. ApprovalPage manager edits).
   *  Buttons shrink from 44px to 32px touch targets — still hits the
   *  iOS recommended minimum but takes less horizontal space. */
  size?: 'md' | 'sm';
  className?: string;
  /**
   * Optional title for the built-in quick-pick sheet, e.g. SKU name.
   * If unset, the sheet uses a generic "Set quantity" label.
   */
  pickTitle?: string;
  /**
   * Override the default preset chips. Falls back to a step-aware
   * default if not provided.
   */
  pickPresets?: number[];
}

const HOLD_THRESHOLD_MS = 350;
const TICK_MS = 90;

export function QtyControl({
  value,
  step = 1,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  unit,
  disabled,
  onChange,
  onRequestManualEntry,
  size = 'md',
  className,
  pickTitle,
  pickPresets,
}: QtyControlProps) {
  const [pressing, setPressing] = useState<'plus' | 'minus' | null>(null);
  const [pickOpen, setPickOpen] = useState(false);
  // M3.12 (2026-05-16): tap-vs-hold disambiguation.
  //
  // Old behaviour fired `adjust()` on `onPointerDown`. That made the
  // increment instantaneous, but it also meant any pointerdown — even
  // one that the user then turned into a scroll gesture — registered a
  // qty change before they let go. The document-level `useTapGuard`
  // hook cancels `click` events on drag, but it has no effect on
  // pointerdown handlers.
  //
  // New flow:
  //   - pointerdown only starts the hold timer; no immediate adjust
  //   - if the user holds past HOLD_THRESHOLD_MS the ramp activates
  //     and we mark `rampedRef` so the trailing click is suppressed
  //   - tap = pointerdown → pointerup → onClick → 1 adjust
  //   - drag = pointerdown → pointermove → pointerleave → no click
  //     (the browser cancels the synthetic click when the touch
  //     drifts off-element, and useTapGuard cancels it if it didn't)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rampedRef = useRef(false);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (holdTimeoutRef.current) clearTimeout(holdTimeoutRef.current);
    intervalRef.current = null;
    holdTimeoutRef.current = null;
    setPressing(null);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const adjust = useCallback(
    (direction: 1 | -1) => {
      // M3.35 (2026-05-19): previously this rounded `value + step` to a
      // multiple of step. That meant a row already at 0.5 with step=1
      // jumped to 2 on tap-+ (Math.round(1.5)=2), not 1.5 — and the
      // display showed "1" via the lossy formatter below. Net effect:
      // staff submitted 0.5 kg, approver opened in claim mode and saw
      // "1 kg" without touching anything.
      //
      // Honest behavior: add `step` to the current value, trim float
      // drift to 3 decimals (matches DB precision), clamp to [min,max].
      // Off-step values stay off-step — the data is the data.
      const raw = value + direction * step;
      const next = clamp(Number(raw.toFixed(3)), min, max);
      if (next !== value) onChange(next);
    },
    [max, min, onChange, step, value],
  );

  /** pointerdown: arm the hold timer, but DON'T adjust yet. */
  const armHold = (direction: 1 | -1, name: 'plus' | 'minus') => {
    if (disabled) return;
    setPressing(name);
    rampedRef.current = false;
    holdTimeoutRef.current = setTimeout(() => {
      rampedRef.current = true;
      // Fire the first ramp tick when the hold threshold elapses so
      // there's a visible response, then keep ticking.
      adjust(direction);
      intervalRef.current = setInterval(() => adjust(direction), TICK_MS);
    }, HOLD_THRESHOLD_MS);
  };

  /** click: the actual tap-confirmed event. Only fires if the touch
   *  didn't drift off-element AND didn't trigger the hold ramp. */
  const handleTap = (direction: 1 | -1) => {
    if (rampedRef.current) {
      // The hold timer already ran the ramp; the trailing click is
      // an artefact of the synthetic click that fires on touchend.
      // Swallow it so we don't over-shoot by one tick.
      rampedRef.current = false;
      return;
    }
    if (disabled) return;
    adjust(direction);
  };

  const isSmall = size === 'sm';
  // M3.15 (2026-05-16): slim the +/- buttons. The 44 px (md) baseline
  // visually outweighed the bottom nav's 22 px icons + 10 px labels,
  // which the user explicitly likes. New defaults:
  //   - md → h-9 (36 px) ·  text-body  · still hits iOS touch target
  //     when the row itself is tappable (it is — the SKU rows below
  //     wrap the whole row in a press handler).
  //   - sm → h-7 (28 px) · text-label · for dense lists (ApprovalPage).
  const tone = (active: boolean) =>
    cn(
      'press inline-flex items-center justify-center rounded-full shrink-0',
      isSmall ? 'h-7 w-7 text-label' : 'h-9 w-9 text-body',
      'bg-[var(--c-surface-2)] ring-hairline text-[var(--c-fg)]',
      active && 'bg-[var(--c-action)] text-[var(--c-action-fg)]',
      disabled && 'opacity-40 pointer-events-none',
    );

  const display = formatQty(value, step);
  const showZero = value === 0;

  const presets = useMemo(
    () => pickPresets ?? defaultPresets(step),
    [pickPresets, step],
  );

  const openQuickPick = () => {
    if (disabled) return;
    if (onRequestManualEntry) {
      onRequestManualEntry();
      return;
    }
    setPickOpen(true);
  };

  return (
    <>
      <div className={cn('inline-flex items-center gap-2', className)}>
        <button
          type="button"
          aria-label="Decrement"
          className={tone(pressing === 'minus')}
          disabled={disabled || value <= min}
          onPointerDown={() => armHold(-1, 'minus')}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onClick={() => handleTap(-1)}
        >
          <span aria-hidden>−</span>
        </button>

        {/* M3.12-C / M3.15 (2026-05-16): fixed width so the +/- buttons
            never shift as the value text grows. Tabular-nums already
            keeps each digit at the same advance width; the unit suffix
            is what pushed the buttons before. Width tuned per size so
            "9999 kg" still fits inside.
            M3.15 shrinks middle font to match the +/- baseline:
              md → text-h3 (was text-h2) — sits with the new 36 px button
              sm → text-body-sm (was text-body) — sits with the 28 px button
            The middle text is no longer the "biggest thing in the row";
            it now reads as a peer of the surrounding row primary text. */}
        <button
          type="button"
          aria-label={`Quantity ${display}${unit ? ' ' + unit : ''} — tap to pick`}
          onClick={openQuickPick}
          disabled={disabled}
          className={cn(
            'press flex items-center justify-center font-semibold tabular-nums',
            isSmall ? 'h-7 w-14 px-1 text-body-sm' : 'h-9 w-16 px-1 text-h3',
            'overflow-hidden whitespace-nowrap',
            showZero && 'text-[var(--c-fg-subtle)] font-normal',
            disabled && 'opacity-40 pointer-events-none',
          )}
        >
          {showZero ? '' : (
            <>
              <span>{display}</span>
              {unit ? (
                <span className="ml-0.5 text-label text-[var(--c-fg-muted)]">{unit}</span>
              ) : null}
            </>
          )}
        </button>

        <button
          type="button"
          aria-label="Increment"
          className={tone(pressing === 'plus')}
          disabled={disabled || value >= max}
          onPointerDown={() => armHold(1, 'plus')}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onClick={() => handleTap(1)}
        >
          <span aria-hidden>+</span>
        </button>
      </div>

      {/* Built-in quick-pick sheet (M3.12-D). Skipped entirely if the
          caller wires their own picker via onRequestManualEntry. */}
      {!onRequestManualEntry ? (
        <QtyQuickPickSheet
          open={pickOpen}
          onOpenChange={setPickOpen}
          title={pickTitle}
          current={value}
          step={step}
          min={min}
          max={max}
          unit={unit}
          presets={presets}
          onPick={(next) => {
            onChange(next);
            setPickOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Built-in quick-pick sheet that opens when the value display is
 * tapped (M3.12-D, M3.14-C).
 *
 * Paths in:
 *   1. Tap a preset chip → onPick(value) → sheet closes
 *   2. Type into the custom input → confirm via Telegram MainButton
 *      (or fallback in-sheet Set button outside Telegram) → onPick →
 *      close
 *
 * M3.14-C (2026-05-16): the in-sheet Set button is replaced by
 * Telegram's MainButton when the WebApp SDK is present. The user
 * called this out — "set quantity 页面不需要单独的set按钮，只需要将
 * telegram的主按钮合理的利用". The MainButton labels itself "Set N kg"
 * mirroring the previous button's text, toggles active/inactive with
 * the draft-differs predicate, and gets save/restored against the
 * parent page's MainButton state so closing the sheet hands the
 * button back to the page (Submit / Confirm / etc.) untouched.
 *
 * Presets default to a step-aware ladder (defaultPresets below), but
 * the caller can override via QtyControl.pickPresets when a SKU has
 * unusual ordering economics (case-of-6, dozen, etc.).
 */
function QtyQuickPickSheet({
  open,
  onOpenChange,
  title,
  current,
  step,
  min,
  max,
  unit,
  presets,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  current: number;
  step: number;
  min: number;
  max: number;
  unit?: string;
  presets: number[];
  onPick: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string>(() => String(current));
  // Re-seed the input every time the sheet opens with a fresh `current`
  // so the user sees what's already there before editing.
  useEffect(() => {
    if (open) setDraft(String(current));
  }, [open, current]);

  const sanitizedDraft = useMemo(() => {
    const n = Number(draft);
    if (!Number.isFinite(n)) return null;
    const clamped = clamp(roundToStep(n, step), min, max);
    return clamped;
  }, [draft, min, max, step]);
  const draftDiffers = sanitizedDraft !== null && sanitizedDraft !== current;

  const setLabel =
    'Set ' +
    (sanitizedDraft !== null ? formatQty(sanitizedDraft, step) : '—') +
    (unit ? ' ' + unit : '');

  // M3.14-C: drive Telegram's MainButton from inside the sheet when
  // the SDK is present. Falls back to the in-sheet <Button> below if
  // we're outside Telegram (web preview, jest, storybook).
  const hasTelegramMainButton = useTelegramMainButton({
    open,
    text: setLabel,
    active: draftDiffers,
    onClick: () => {
      if (sanitizedDraft !== null) onPick(sanitizedDraft);
    },
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? 'Set quantity'}
      description={unit ? `Unit: ${unit}` : undefined}
      footer={
        // When Telegram is driving the MainButton, the in-sheet footer
        // is empty — the system button at the bottom of the WebApp
        // viewport is the confirmation affordance. Outside Telegram
        // (preview / desktop), keep the fallback button visible so the
        // sheet remains usable.
        hasTelegramMainButton ? null : (
          <SheetFooter>
            <Button
              block
              disabled={!draftDiffers}
              onClick={() => {
                if (sanitizedDraft !== null) onPick(sanitizedDraft);
              }}
            >
              {setLabel}
            </Button>
          </SheetFooter>
        )
      }
    >
      <div className="flex flex-col gap-3 py-3">
        {/* Preset chips — tap once = done. The most common path. */}
        <div className="flex flex-wrap gap-2">
          {presets
            .filter((p) => p >= min && p <= max)
            .map((p) => {
              const selected = p === current;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => onPick(p)}
                  className={cn(
                    'press rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ring-hairline',
                    selected
                      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                      : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]',
                  )}
                >
                  {formatQty(p, step)}
                  {unit ? <span className="ml-1 opacity-70">{unit}</span> : null}
                </button>
              );
            })}
        </div>

        {/* Custom input — escape hatch for non-preset quantities. */}
        {/* M3.13 typography exception: native <label> needs to wrap the
            input for click-to-focus, and we want it visually to read as
            an eyebrow above the input. SectionLabel renders as a
            non-form element, so we keep the eyebrow class string here.
            The CI typography guard allow-lists this comment. */}
        <label className="block text-label font-semibold uppercase tracking-eyebrow text-[var(--c-fg-muted)]">
          Custom
          <NumberInput
            className="mt-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            step={step}
            min={min}
            max={max}
            inputMode="decimal"
          />
        </label>
      </div>
    </Sheet>
  );
}

// ──────────────────────────────────────────────────────────────────
// Telegram MainButton override (M3.14-C, 2026-05-16)
// ──────────────────────────────────────────────────────────────────
//
// Hook the sheet uses to temporarily commandeer Telegram's MainButton
// while it's open. Three-step lifecycle:
//
//   1. On open: snapshot the live button (text, isVisible, isActive),
//      bind our click handler, override text, ensure visible, set
//      active state.
//   2. While open: update text + active state as the draft changes.
//      We do NOT touch visibility on this path — the override stays
//      on for the duration of the sheet.
//   3. On close: deregister click handler, restore the snapshot
//      (setText back, hide if it was hidden, restore active state).
//      Importantly this keeps the parent page's `usePageMainButton`
//      hook in a consistent state — the parent's `lastTextRef` etc.
//      reflected whatever the live state was before we entered, and
//      we leave the live state matching that.
//
// Returns `true` if the sheet is inside Telegram and the MainButton
// is driving the confirm action (so the caller should hide the
// in-sheet fallback button). Returns `false` outside Telegram —
// caller renders the in-sheet button as before.
//
// The hook is self-contained in @compass/ui because Sheet already
// lazily reaches into `window.Telegram?.WebApp?.BackButton` with the
// same defensive optionality. Keeping MainButton wiring in the same
// place means the QtyControl works in any host (apps/web today,
// future admin tool, future kitchen display) without re-implementing
// the dance.
type TgMainButton = {
  text?: string;
  isVisible?: boolean;
  isActive?: boolean;
  setText: (s: string) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
};

function getMainButton(): TgMainButton | null {
  if (typeof window === 'undefined') return null;
  const w = window as { Telegram?: { WebApp?: { MainButton?: TgMainButton } } };
  return w.Telegram?.WebApp?.MainButton ?? null;
}

function useTelegramMainButton({
  open,
  text,
  active,
  onClick,
}: {
  open: boolean;
  text: string;
  active: boolean;
  onClick: () => void;
}): boolean {
  // Keep the latest click handler behind a ref so we can bind ONCE
  // per open-cycle without re-registering every render. Re-registering
  // produces a brief visible blip on iOS Telegram.
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  // Snapshot of pre-override state, restored on close.
  const snapshotRef = useRef<{ text: string; visible: boolean; active: boolean } | null>(null);

  const driving = open && !!getMainButton();

  // Open/close lifecycle. Take/release the MainButton in lockstep with
  // `open`. Active-state and text changes ride on the separate effect
  // below so they don't trigger a snapshot reset mid-sheet.
  useEffect(() => {
    const mb = getMainButton();
    if (!open || !mb) return;

    snapshotRef.current = {
      text: mb.text ?? '',
      visible: !!mb.isVisible,
      active: !!mb.isActive,
    };

    const handler = () => onClickRef.current();
    mb.onClick(handler);
    mb.show();

    return () => {
      mb.offClick(handler);
      const snap = snapshotRef.current;
      if (snap) {
        // Restore text first so the brief "between" frame on iOS
        // doesn't flash our override.
        mb.setText(snap.text || '');
        if (!snap.visible) mb.hide();
        if (snap.active) mb.enable();
        else mb.disable();
      }
      snapshotRef.current = null;
    };
  }, [open]);

  // Text + active updates while open. Skipped outside Telegram.
  useEffect(() => {
    if (!open) return;
    const mb = getMainButton();
    if (!mb) return;
    mb.setText(text);
    if (active) mb.enable();
    else mb.disable();
  }, [open, text, active]);

  return driving;
}

/**
 * Generate a sensible default preset ladder based on `step`. Tuned for
 * restaurant procurement quantities — small steps get small ladders
 * (you don't order 100 kg of saffron at 0.01 kg step), big steps get
 * round commodity numbers (1, 2, 5, 10, 20, 50, 100 pcs).
 */
function defaultPresets(step: number): number[] {
  if (step >= 1) return [1, 2, 5, 10, 20, 50, 100];
  if (step >= 0.5) return [0.5, 1, 2, 5, 10, 20, 50];
  if (step >= 0.1) return [0.1, 0.5, 1, 2, 5, 10, 20];
  return [0.01, 0.1, 0.5, 1, 2, 5, 10];
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function roundToStep(v: number, step: number): number {
  if (step <= 0) return v;
  const ratio = Math.round(v / step);
  return Number((ratio * step).toFixed(3));
}

function formatQty(v: number, _step: number): string {
  // M3.35 (2026-05-19): display the actual value, not a step-snapped
  // version. Previously `step >= 1` forced Math.round which turned a
  // legitimate 0.5 kg into "1 kg" on screen — divergent from server
  // truth. Trim to 3 decimals (DB precision), Number() strips trailing
  // zeros so whole-step values still read as "3" rather than "3.000".
  // `step` kept in signature so callers don't have to change.
  return String(Number(v.toFixed(3)));
}
