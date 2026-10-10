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
  className,
}: ChoiceGroupProps<V>) {
  return (
    <div className={cn('flex flex-col gap-sm', className)}>
      <span className="text-label text-ink">{label}</span>
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
                'flex h-control min-w-0 flex-1 items-center justify-center rounded-sm border px-md text-label outline-none',
                chosen
                  ? 'border-primary bg-surface text-primary ring-1 ring-primary'
                  : 'border-line bg-surface text-secondary active:bg-surface-sunken',
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
