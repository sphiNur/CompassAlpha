import { forwardRef, useId, type ReactNode } from 'react';
import { cn } from '../cn';
import { Button } from './Button';
import { joinIds, useFieldControl } from './fieldControl';
import { IconChevronRight } from './NavIcon';

/**
 * A field whose value is chosen in a sheet: it shows the current choice
 * and opens the picker. Put it in a `<Field>`, as a Select is.
 *
 * Review UI-01 (2026-11-12): the settlement's employee field drew its own
 * button inside the field's `<label>`, wired its own error line and named
 * itself by hand. Here the Field's label and the choice name it
 * ("Employee Ali"), and the Field's error and hint describe it.
 */
export interface PickerButtonProps {
  /** The current choice, or what to do when there is none. */
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export const PickerButton = forwardRef<HTMLButtonElement, PickerButtonProps>(function PickerButton(
  { children, onClick, disabled, className },
  ref,
) {
  const field = useFieldControl();
  const valueId = useId();
  return (
    <Button
      ref={ref}
      id={field?.id}
      type="button"
      variant="secondary"
      block
      className={cn('justify-between text-left', className)}
      aria-haspopup="dialog"
      aria-labelledby={field ? joinIds(field.labelId, valueId) : undefined}
      aria-describedby={field?.describedBy}
      aria-invalid={field?.invalid || undefined}
      disabled={disabled}
      trailingIcon={<IconChevronRight size={16} />}
      onClick={onClick}
    >
      <span id={valueId} className="block truncate">
        {children}
      </span>
    </Button>
  );
});
