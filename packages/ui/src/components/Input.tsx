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
      // Height = --control-h (40px, the standard form-control tier;
      // M3.15 lowered it from 44→40 to match the Button md baseline so
      // an Input + Button row reads as same-rhythm controls). Select
      // shares this token so Input and Select finally line up. Text
      // stays text-h3 (14 px).
      // Capsule pass (2026-07-31): fields are flat filled capsules like
      // Telegram's own search field — surface-2 fill, no resting
      // hairline. Focus/invalid rings unchanged.
      className={cn(
        'h-[var(--control-h)] w-full min-w-0 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3',
        'text-[var(--c-fg)] placeholder:text-[var(--c-fg-subtle)]',
        'outline-none',
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
