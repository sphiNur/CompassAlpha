import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Why a field's value is refused, under the field: the danger colour and a
 * warning sign (so the colour is not the only cue), announced as an alert.
 * Give it the `id` the input names in `aria-describedby`.
 *
 * Review CONF-21: the daily close drew its own (red with a ⚠ character),
 * the receiving sheet its own (amber, no sign) and the kit's number
 * fields a third (red, no sign). The sign is drawn, not a character, so
 * the line's text is the message alone.
 */
export function FieldError({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      id={id}
      role="alert"
      className={cn('mt-1 flex items-start gap-1 text-old-label text-[var(--c-danger)]', className)}
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        fill="currentColor"
        fillRule="evenodd"
        className="mt-[0.2em] h-[1em] w-[1em] shrink-0"
      >
        <path d="M8 1 15.5 14.5H.5ZM7.25 5.5h1.5v5h-1.5ZM7.25 11.5h1.5V13h-1.5Z" />
      </svg>
      <span>{children}</span>
    </span>
  );
}
