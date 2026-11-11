import { cn } from '../cn';
import { useUiLabels } from '../labels';
import { Spinner } from './Spinner';

/**
 * A loading state on its own (review UI-13, 2026-11-11). DataState's
 * spinner said nothing to a screen reader (Spinner is aria-hidden), so
 * pages re-made the block with `role="status"`, each with its own
 * padding (py-4 / 6 / 8 / 12), or wrote "spinner + Loading roles…" by
 * hand, and most spinners said nothing at all.
 *
 *   - block    a page's or a sheet's content while it loads (DataState's).
 *   - compact  a section inside a card or a sheet.
 *   - inline   a line in a form, with the words beside the spinner
 *              ("Loading roles…").
 *
 * `label` defaults to the kit's "Loading…". The block and compact
 * variants say it to a screen reader only; inline shows it.
 */
export type LoadingStateVariant = 'block' | 'compact' | 'inline';

export function LoadingState({
  variant = 'block',
  label,
  className,
}: {
  variant?: LoadingStateVariant;
  label?: string;
  className?: string;
}) {
  const labels = useUiLabels();
  const text = label ?? labels.loading;
  if (variant === 'inline') {
    return (
      <div
        role="status"
        className={cn(
          'flex items-center gap-2 text-old-body-sm text-[var(--c-fg-muted)]',
          className,
        )}
      >
        <Spinner size={14} />
        {text}
      </div>
    );
  }
  const compact = variant === 'compact';
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-center text-[var(--c-fg-muted)]',
        compact ? 'py-6' : 'py-12',
        className,
      )}
    >
      <Spinner size={compact ? 16 : 28} />
      <span className="sr-only">{text}</span>
    </div>
  );
}
