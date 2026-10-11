import { cn } from '../cn';

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
}

export interface ChoiceGroupProps<V extends string> {
  /** What is being chosen, for screen readers and shown above the options. */
  label: string;
  options: Array<ChoiceOption<V>>;
  value: V;
  onChange: (value: V) => void;
  /**
   * A switch for how a list is shown, not a field in a form: the label
   * is kept for screen readers only.
   */
  compact?: boolean;
  className?: string;
}

/**
 * Pick exactly one of two or three. The options sit side by side at full
 * button height, and the chosen one is outlined and inked in green, so
 * the current answer can be read without touching anything.
 */
export function ChoiceGroup<V extends string>({
  label,
  options,
  value,
  onChange,
  compact = false,
  className,
}: ChoiceGroupProps<V>) {
  return (
    <div className={cn('flex flex-col gap-sm', className)}>
      {compact ? null : <span className="text-label text-ink">{label}</span>}
      {/* The chosen option is ink with the accent as its text: the
          strongest contrast on the screen, so the choice is never in doubt. */}
      <div role="radiogroup" aria-label={label} className="flex gap-sm">
        {options.map((option) => {
          const chosen = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={chosen}
              data-choice={option.value}
              onClick={() => onChange(option.value)}
              className={cn(
                'flex h-tap min-w-0 flex-1 items-center justify-center rounded-pill px-md text-label outline-none',
                'focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2',
                chosen
                  ? 'bg-contrast text-on-contrast'
                  : 'bg-surface-sunken text-ink active:bg-line',
              )}
            >
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
