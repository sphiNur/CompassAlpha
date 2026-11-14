import { createContext, useContext } from 'react';

/**
 * What a Field tells the control inside it (review UI-02, 2026-11-11):
 * the ids of its error and hint lines, whether it shows an error, and
 * whether the value is required. The kit's Input, Select, Textarea and
 * PickerButton read it, so a page gives Field its `error`, `hint` and
 * `required` once instead of wiring ids by hand.
 *
 * Review UI-01 (2026-11-12): the Field's label names its control through
 * `id`, the id the control takes (a control's own `id` wins, and then
 * the label names nothing). `labelId` is the label's own id.
 *
 * `reportFormatError` lets a number field hand its "not one number" line
 * to the Field, which draws it in the same place as any other error.
 */
export interface FieldControl {
  id: string;
  labelId: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
  reportFormatError: (controlId: string, shown: boolean) => void;
}

export const FieldControlContext = createContext<FieldControl | null>(null);

/** The Field around this control, or null outside one. */
export function useFieldControl(): FieldControl | null {
  return useContext(FieldControlContext);
}

/** Space-separated ids without the empty ones; undefined when none is left. */
export function joinIds(...ids: (string | false | null | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined === '' ? undefined : joined;
}

/**
 * Review MWA-15: whether a control is required — its Field says so, or
 * the caller set `required` itself. Undefined when not, so no attribute.
 */
export function fieldRequired(
  field: Pick<FieldControl, 'required'> | null,
  own: boolean | undefined,
): true | undefined {
  return field?.required || own ? true : undefined;
}
