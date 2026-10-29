/**
 * What someone typed into a decimal field, as a string Number() reads
 * (R6, 2026-10-30). Fields used `<input type="number">`, which drops or
 * rejects a decimal comma: "1,5" became 15 or empty, silently — a sale of
 * 15 portions, a tax rate of 15 %. Russian and Uzbek keyboards put the
 * comma where the decimal point is.
 *
 * - a comma is the decimal point ("1,5" → "1.5", "1 234,5" → "1234.5");
 * - with both marks present, the last one is the decimal mark and the
 *   other groups digits ("1,234.5" and "1.234,5" → "1234.5");
 * - spaces (incl. no-break / narrow no-break) are dropped;
 * - only the first decimal point survives; "-" only at the start.
 *
 * "12,000" typed as twelve thousand reads as 12: in Uzbekistan digits are
 * grouped with spaces and the comma is the decimal mark, so that is the
 * safer reading.
 */
export function normalizeDecimalInput(raw: string): string {
  let text = raw.replace(/[\s  ]/g, '');
  if (text.includes(',') && text.includes('.')) {
    // Both marks: the last one is the decimal mark, the other groups digits.
    text =
      text.lastIndexOf(',') > text.lastIndexOf('.')
        ? text.replace(/\./g, '').replace(/,/g, '.')
        : text.replace(/,/g, '');
  } else {
    text = text.replace(/,/g, '.');
  }
  const negative = text.startsWith('-');
  text = text.replace(/[^0-9.]/g, '');
  const dot = text.indexOf('.');
  if (dot !== -1) text = text.slice(0, dot + 1) + text.slice(dot + 1).replace(/\./g, '');
  return (negative ? '-' : '') + text;
}
