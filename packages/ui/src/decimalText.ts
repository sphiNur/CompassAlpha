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
 * "12,000" depends on the interface language (RE-CLS-4): twelve thousand
 * in Chinese and English, 12 in Russian and Uzbek, where digits are grouped
 * with spaces and the comma is the decimal mark.
 */
let decimalLocale: string | null = null;

/**
 * RE-CLS-4 (2026-10-30): the host tells which interface language is in use
 * (UiLabelsBridge). Chinese and English write "1,000" for one thousand;
 * Russian and Uzbek write it for 1.000. Reading every comma as the decimal
 * mark stored a counted "1,000" kg as 1 kg.
 */
export function setDecimalLocale(locale: string | null): void {
  decimalLocale = locale;
}

function commaGroupsThousands(): boolean {
  const locale =
    decimalLocale ?? (typeof document !== 'undefined' ? document.documentElement.lang : '');
  return /^(zh|en)\b/i.test(locale ?? '');
}

export function normalizeDecimalInput(raw: string): string {
  let text = raw.replace(/[\s  ]/g, '');
  // zh / en: commas between groups of exactly three digits are thousands
  // separators ("1,000", "12,500.5"). "1,5" stays a decimal comma everywhere.
  if (commaGroupsThousands() && /^-?\d{1,3}(,\d{3})+(\.\d*)?$/.test(text)) {
    text = text.replace(/,/g, '');
  }
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
