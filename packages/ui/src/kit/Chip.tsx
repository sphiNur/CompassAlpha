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
 * How a line was paid. Cash is quiet and transfer is ink with the accent,
 * so a list can be scanned for one of them. In a Row it goes in `valueNote`, under the
 * amount it describes, which puts it at the same place on every screen.
 */
export function PaymentChip({ method, label, className }: PaymentChipProps) {
  return (
    <span
      data-payment-method={method}
      className={cn(
        CHIP,
        method === 'transfer' ? 'bg-ink text-primary' : 'bg-neutral text-ink',
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

const TONE: Record<StatusTone, string> = {
  neutral: 'bg-neutral text-ink',
  pending: 'bg-warning-pale text-warning-ink',
  done: 'bg-primary-pale text-forest',
  problem: 'bg-danger-pale text-danger-ink',
};

/**
 * The state of a thing, in words. The fill repeats the state as a colour
 * for scanning a list; each pairing is readable on its own.
 */
export function StatusChip({ tone = 'neutral', children, className }: StatusChipProps) {
  return (
    <span data-status={tone} className={cn(CHIP, TONE[tone], className)}>
      {children}
    </span>
  );
}
