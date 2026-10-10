import type { ReactNode } from 'react';
import { cn } from '../cn';

const CHIP =
  'inline-flex shrink-0 items-center gap-xs whitespace-nowrap rounded-pill px-md py-xs text-caption';

export type PaymentMethod = 'cash' | 'transfer';

export interface PaymentChipProps {
  method: PaymentMethod;
  /** The method's name in the user's language. Always words, never a glyph. */
  label: string;
  className?: string;
}

/**
 * How a line was paid. Cash is quiet and transfer is blue, so a list can
 * be scanned for one of them. In a Row it goes in `valueNote`, under the
 * amount it describes, which puts it at the same place on every screen.
 */
export function PaymentChip({ method, label, className }: PaymentChipProps) {
  return (
    <span
      data-payment-method={method}
      className={cn(
        CHIP,
        method === 'transfer' ? 'bg-info text-on-primary' : 'bg-surface-sunken text-ink',
        className,
      )}
    >
      {label}
    </span>
  );
}

export type StatusTone = 'neutral' | 'pending' | 'done' | 'problem';

export interface StatusChipProps {
  /**
   * `pending` is waiting on someone, `done` needs nothing more, `problem`
   * needs attention. `neutral` carries no judgement.
   */
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}

const DOT: Record<StatusTone, string | null> = {
  neutral: null,
  pending: 'bg-warning',
  done: 'bg-success',
  problem: 'bg-danger',
};

/**
 * The state of a thing, in words. The dot repeats the state as a colour
 * for scanning; the text stays ink so it is readable on its own.
 */
export function StatusChip({ tone = 'neutral', children, className }: StatusChipProps) {
  const dot = DOT[tone];
  return (
    <span data-status={tone} className={cn(CHIP, 'bg-surface-sunken text-ink', className)}>
      {dot ? <span aria-hidden className={cn('size-sm rounded-pill', dot)} /> : null}
      {children}
    </span>
  );
}
