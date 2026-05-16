import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../cn';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      // M3.15 (2026-05-16): h-11 (44 px) → h-10 (40 px). Matches the
      // new Button md baseline so a row with an Input + a Button reads
      // as same-rhythm controls. Text stays at text-h3 (14 px).
      className={cn(
        'h-10 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3',
        'text-[var(--c-fg)] placeholder:text-[var(--c-fg-subtle)]',
        'outline-none ring-hairline',
        'focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--c-bg)]',
        invalid && 'ring-2 ring-[var(--c-danger)]',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});
