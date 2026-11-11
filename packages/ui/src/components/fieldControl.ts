import { createContext, useContext } from 'react';

/**
 * What a Field tells the control inside it (review UI-02, 2026-11-11):
 * the ids of its error and hint lines, whether it shows an error, and
 * whether the value is required. The kit's Input, Select and Textarea
 * read it, so a page gives Field its `error`, `hint` and `required` once
 * instead of wiring ids by hand.
 *
 * `reportFormatError` lets a number field hand its "not one number" line
 * to the Field, which draws it in the same place as any other error.
 */
export interface FieldControl {
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
