/**
 * Focus the first element found by `selectors`, tried in order.
 *
 * Review COREWEB1-25 (2026-11-11): "skip to navigation" used one selector
 * list, `'nav [aria-current="page"], nav button'`. querySelector returns
 * the first match in document order whichever selector matched, so the
 * first tab always won over the current one.
 */
export function focusFirst(
  selectors: readonly string[],
  root: Pick<ParentNode, 'querySelector'> = document,
): boolean {
  for (const selector of selectors) {
    const target = root.querySelector<HTMLElement>(selector);
    if (target) {
      target.focus();
      return true;
    }
  }
  return false;
}
