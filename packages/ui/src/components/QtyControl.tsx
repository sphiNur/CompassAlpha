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
      const next = clamp(roundToStep(value + direction * step, step), min, max);
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
  const tone = (active: boolean) =>
    cn(
      'press inline-flex items-center justify-center rounded-full shrink-0',
      isSmall ? 'h-8 w-8 text-body' : 'h-11 w-11',
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

        {/* M3.12-C: fixed width so the +/- buttons never shift as the
            value text grows. Tabular-nums already keeps each digit at
            the same advance width; the unit suffix is what pushed the
            buttons before. `w-20` (80px) fits up to 4 integer digits
            + 1 decimal + 2-char unit at text-h2; w-16 at text-body for
            the compact variant. Overflow stays inside the box. */}
        <button
          type="button"
          aria-label={`Quantity ${display}${unit ? ' ' + unit : ''} — tap to pick`}
          onClick={openQuickPick}
          disabled={disabled}
          className={cn(
            'press flex h-11 items-center justify-center font-semibold tabular-nums',
            isSmall ? 'h-8 w-16 px-1 text-body' : 'w-20 px-1 text-h2',
            'overflow-hidden whitespace-nowrap',
            showZero && 'text-[var(--c-fg-subtle)] font-normal',
            disabled && 'opacity-40 pointer-events-none',
          )}
        >
          {showZero ? '−' : (
            <>
              <span>{display}</span>
              {unit ? (
                <span className="ml-1 text-label text-[var(--c-fg-muted)]">{unit}</span>
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
 * tapped (M3.12-D). Two paths in:
 *   1. Tap a preset chip → onPick(value) → sheet closes
 *   2. Type into the custom input → tap Set → onPick(value) → close
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

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? 'Set quantity'}
      description={unit ? `Unit: ${unit}` : undefined}
      footer={
        <SheetFooter>
          <Button
            block
            disabled={!draftDiffers}
            onClick={() => {
              if (sanitizedDraft !== null) onPick(sanitizedDraft);
            }}
          >
            Set {sanitizedDraft !== null ? formatQty(sanitizedDraft, step) : '—'}
            {unit ? ' ' + unit : ''}
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

function formatQty(v: number, step: number): string {
  if (step >= 1) return String(Math.round(v));
  return String(Number(v.toFixed(3)));
}
