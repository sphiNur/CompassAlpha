import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** What is being asked for. Always shown: a placeholder disappears on the first keystroke. */
  label: string;
  /** After the value, inside the box: a unit, or a control that changes the unit. */
  suffix?: ReactNode;
  /** Numbers are right-aligned in tabular figures so stacked fields line up. */
  numeric?: boolean;
  className?: string;
}

/** One labelled input, 52px tall. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, suffix, numeric = false, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className={cn('flex flex-col gap-sm', className)}>
      <label htmlFor={inputId} className="text-label text-ink">
        {label}
      </label>
      <div className="flex h-control items-center gap-sm rounded-sm border border-line bg-surface px-lg focus-within:border-primary">
        <input
          ref={ref}
          id={inputId}
          {...(numeric ? { inputMode: 'decimal' as const, autoComplete: 'off' } : {})}
          {...rest}
          className={cn(
            'h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-secondary',
            numeric ? 'text-right text-money' : 'text-body',
          )}
        />
        {suffix ? <span className="shrink-0 text-body text-secondary">{suffix}</span> : null}
      </div>
    </div>
  );
});
