import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { spokenText, useAnnounceShown } from '../announce';
import { cn } from '../cn';
import { useUiLabels } from '../labels';

/**
 * Why a field's value is refused, under the field: the danger colour and a
 * warning sign (so the colour is not the only cue). Give it the `id` the
 * input names in `aria-describedby`.
 *
 * Review CONF-21: the daily close drew its own (red with a ⚠ character),
 * the receiving sheet its own (amber, no sign) and the kit's number
 * fields a third (red, no sign). The sign is drawn, not a character, so
 * the line's text is the message alone.
 *
 * Review MWA-03 (modern-web-guidance: accessible-error-announcement): the
 * line is no longer its own `role="alert"` region. Each error was an
 * assertive region mounted already holding its text, which is not read
 * reliably, and several on one sheet interrupted each other while the
 * person typed. The control points at the line (aria-describedby,
 * aria-invalid); the error is said once through the host's polite region
 * (useUiAnnounce), a moment after it appears or changes, after the
 * field's name: `labelledBy` (the id of the field's label, as Field
 * passes it) or `label`.
 */
export function FieldError({
  id,
  className,
  children,
  labelledBy,
  label,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
  /** Id of the field's label, read for the announcement. */
  labelledBy?: string;
  /** The field's name for the announcement, when it has no label element. */
  label?: string;
}) {
  const labels = useUiLabels();
  const ref = useRef<HTMLSpanElement>(null);
  const [said, setSaid] = useState<string | null>(null);
  // Read from the DOM after the message renders: `children` and the label
  // may be any node, so this takes what a screen reader would read.
  useEffect(() => {
    const message = spokenText(ref.current);
    const name =
      label ??
      (labelledBy && typeof document !== 'undefined'
        ? spokenText(document.getElementById(labelledBy))
        : '');
    const next = message ? labels.fieldError(name, message) : null;
    setSaid((prev) => (prev === next ? prev : next));
  }, [children, label, labelledBy, labels]);
  useAnnounceShown(said);
  return (
    <span
      ref={ref}
      id={id}
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
