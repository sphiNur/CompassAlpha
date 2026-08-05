import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUiLabels } from '../labels';
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
  // 2026-07-30: aria-labels and the entire quick-pick sheet were frozen
  // English in a package with no i18n dependency. See ../labels.tsx.
  const labels = useUiLabels();
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
          aria-label={labels.decrement}
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
          aria-label={labels.quantityPick(`${display}${unit ? ' ' + unit : ''}`)}
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
          {/*
            2026-07-30 (flow review): this used to render the EMPTY STRING at
            value 0. On a fresh order that left a ~64 px invisible button on
            every one of ~190 rows — and that button is the quick-pick sheet,
            i.e. the fast path to "12 kg" in one tap. It was undiscoverable,
            and the blank gap between − and + made each row look broken.

            Now zero renders a subdued `0` plus the unit, so the tap target is
            visible and the row states its unit without the caption M3.55
            removed. Non-zero values are unchanged.
          */}
          <span>{display}</span>
          {unit ? (
            <span className="ml-0.5 text-label text-[var(--c-fg-muted)]">{unit}</span>
          ) : null}
        </button>

        <button
          type="button"
          data-testid="qty-increment"
          aria-label={labels.increment}
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
  const labels = useUiLabels();
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

  const setLabel = labels.setValue(
    (sanitizedDraft !== null ? formatQty(sanitizedDraft, step) : '—') +
      (unit ? ' ' + unit : ''),
  );

  // 2026-07-30: this sheet used to commandeer Telegram's native
  // MainButton (M3.14-C) and suppress its own footer whenever the SDK
  // was present. Both halves of that broke:
  //
  //   - The host retired the native MainButton in M3.49 — Shell renders
  //     an in-DOM PageMainButton above the nav and calls
  //     `tg.MainButton.hide()` permanently, precisely so the button
  //     appearing/disappearing stops shoving the bottom nav around.
  //     Grabbing it here resurrected exactly that layout shift.
  //   - The "is the SDK present" test (`!!getMainButton()`) is TRUE in
  //     any browser, because index.html loads telegram-web-app.js as a
  //     static script. So outside Telegram the footer was suppressed AND
  //     no native button existed: typing a custom quantity had nothing to
  //     confirm it with. Verified on 2026-07-30 — the open sheet's only
  //     controls were the preset chips and a bare number input.
  //
  // The sheet now always renders its own confirm button, which is what
  // ConfirmPage's issue sheet and RunSheets' confirm sheet already do
  // (see their M3.49 notes). `Sheet` renders above PageMainButton, so
  // there's nothing to collide with.

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? labels.setQuantity}
      description={unit ? labels.unitIs(unit) : undefined}
      footer={
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
          {labels.custom}
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
