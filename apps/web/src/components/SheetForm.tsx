import type { ReactNode } from 'react';

/**
 * The body of a data-entry sheet as a real form (modern-web-guidance:
 * forms), so the keyboard's Go / Enter in a field presses the footer's
 * submit button. That button sits outside the body (in the sheet's
 * footer) and joins the form with `type="submit" form={id}`.
 *
 * The button keeps doing the work in its onClick: Enter in a field
 * "clicks" the form's submit button, so the kit Button's rules apply to
 * Enter as to a tap: a loading button drops it, a button waiting for the
 * form (disabledHint) points at what is missing, a disabled one is not
 * pressed, and a repeat inside the tap guard's window is dropped. The
 * form's own submit therefore only stops the page from navigating; it
 * must not send anything itself, or a tap would send twice.
 *
 * Enter inside a textarea still inserts a new line (browsers never submit
 * from a textarea). `noValidate`: the sheets show their own field errors.
 */
export function SheetForm({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <form id={id} className={className} noValidate onSubmit={(e) => e.preventDefault()}>
      {children}
    </form>
  );
}
