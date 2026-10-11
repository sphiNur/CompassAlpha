import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface RowProps {
  /** What the row is: a product, a store, a person. */
  title: ReactNode;
  /** One supporting line in the secondary colour, same size as the title. */
  detail?: ReactNode;
  /** Right-hand value, normally a <Money>. Right-aligned so rows form a column. */
  value?: ReactNode;
  /** Sits under the value. This is where a PaymentChip goes, on every screen. */
  valueNote?: ReactNode;
  /** Makes the row's name and value one touch target. */
  onPress?: () => void;
  /**
   * A control of its own at the right edge, outside the row's touch
   * target: the one thing that can be done to this row without opening
   * it. A Button or a Stepper, never a second column of information.
   */
  trailing?: ReactNode;
  /**
   * The row is something to do ("Add an item"), not something to read:
   * its name takes the action colour.
   */
  action?: boolean;
  /**
   * Pressing the row picks it rather than opening it (a store in a
   * list of stores): no chevron.
   */
  picks?: boolean;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

/**
 * A name on the left, a value on the right, nothing in between.
 *
 * At least 56px tall. Text that does not fit wraps and makes the row
 * taller; it is never shrunk or cut to keep the row short.
 */
export function Row({
  title,
  detail,
  value,
  valueNote,
  onPress,
  trailing,
  action,
  picks,
  disabled,
  className,
  ...rest
}: RowProps) {
  const body = (
    <>
      <span className="min-w-0 flex-1 text-start">
        <span className={cn('block', action ? 'text-label text-forest' : 'text-label text-ink')}>
          {title}
        </span>
        {detail ? <span className="block text-small text-secondary">{detail}</span> : null}
      </span>
      {value || valueNote ? (
        <span className="flex shrink-0 flex-col items-end gap-xs">
          {value}
          {valueNote}
        </span>
      ) : null}
      {/* Says the row opens something. Not on a row that is itself the
          action, nor beside a control that already is one. */}
      {onPress && !trailing && !action && !picks ? (
        <span
          aria-hidden
          data-row-chevron
          className="shrink-0 text-h2 text-secondary rtl:-scale-x-100"
        >
          ›
        </span>
      ) : null}
    </>
  );
  const box = cn('flex min-h-row w-full items-center gap-lg px-lg py-md', className);
  if (trailing) {
    const inner = 'flex min-w-0 flex-1 items-center gap-lg self-stretch text-start outline-none';
    return (
      <div role="listitem" data-testid={rest['data-testid']} className={cn(box, 'gap-md')}>
        {onPress ? (
          <button
            type="button"
            onClick={onPress}
            disabled={disabled}
            data-row-open
            className={cn(inner, 'active:opacity-60 disabled:opacity-60')}
          >
            {body}
          </button>
        ) : (
          <span className={inner}>{body}</span>
        )}
        <span className="shrink-0">{trailing}</span>
      </div>
    );
  }
  if (onPress) {
    return (
      <div role="listitem">
        <button
          type="button"
          onClick={onPress}
          disabled={disabled}
          data-testid={rest['data-testid']}
          className={cn(
            box,
            'outline-none active:bg-surface-sunken focus-visible:bg-surface-sunken disabled:opacity-60',
          )}
        >
          {body}
        </button>
      </div>
    );
  }
  return (
    <div role="listitem" data-testid={rest['data-testid']} className={box}>
      {body}
    </div>
  );
}
