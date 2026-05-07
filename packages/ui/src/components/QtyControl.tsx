import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../cn';

interface QtyControlProps {
  value: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
  /** Tap on the number to open a manual entry sheet. The host wires this. */
  onRequestManualEntry?: () => void;
  /** Compact variant for dense lists (e.g. ApprovalPage manager edits).
   *  Buttons shrink from 44px to 32px touch targets — still hits the
   *  iOS recommended minimum but takes less horizontal space. */
  size?: 'md' | 'sm';
  className?: string;
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
}: QtyControlProps) {
  const [pressing, setPressing] = useState<'plus' | 'minus' | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const begin = (direction: 1 | -1, name: 'plus' | 'minus') => {
    if (disabled) return;
    adjust(direction);
    setPressing(name);
    holdTimeoutRef.current = setTimeout(() => {
      intervalRef.current = setInterval(() => adjust(direction), TICK_MS);
    }, HOLD_THRESHOLD_MS);
  };

  const isSmall = size === 'sm';
  const tone = (active: boolean) =>
    cn(
      'press inline-flex items-center justify-center rounded-full',
      isSmall ? 'h-8 w-8 text-body' : 'h-11 w-11',
      'bg-[var(--c-surface-2)] ring-hairline text-[var(--c-fg)]',
      active && 'bg-[var(--c-action)] text-[var(--c-action-fg)]',
      disabled && 'opacity-40 pointer-events-none',
    );

  const display = formatQty(value, step);
  const showZero = value === 0;

  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <button
        type="button"
        aria-label="Decrement"
        className={tone(pressing === 'minus')}
        disabled={disabled || value <= min}
        onPointerDown={() => begin(-1, 'minus')}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
      >
        <span aria-hidden>−</span>
      </button>

      <button
        type="button"
        aria-label={`Quantity ${display}${unit ? ' ' + unit : ''}`}
        onClick={onRequestManualEntry}
        className={cn(
          'press text-center font-semibold tabular-nums',
          isSmall ? 'min-w-[44px] px-1 text-body' : 'min-w-[64px] px-2 text-h2',
          showZero && 'text-[var(--c-fg-subtle)] font-normal',
        )}
      >
        {showZero ? '−' : display}
        {!showZero && unit ? <span className="ml-1 text-label text-[var(--c-fg-muted)]">{unit}</span> : null}
      </button>

      <button
        type="button"
        aria-label="Increment"
        className={tone(pressing === 'plus')}
        disabled={disabled || value >= max}
        onPointerDown={() => begin(1, 'plus')}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
      >
        <span aria-hidden>+</span>
      </button>
    </div>
  );
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
