/**
 * What someone typed into a decimal field, as a string Number() reads
 * (R6, 2026-10-30). Fields used `<input type="number">`, which drops or
 * rejects a decimal comma: "1,5" became 15 or empty, silently — a sale of
 * 15 portions, a tax rate of 15 %. Russian and Uzbek keyboards put the
 * comma where the decimal point is.
 *
 * - a comma is the decimal point ("1,5" → "1.5", "1 234,5" → "1234.5");
 * - with both marks present, the last one is the decimal mark and the
 *   other groups digits in threes ("1,234.5" and "1.234,5" → "1234.5");
 * - spaces (incl. no-break / narrow no-break) are dropped;
 * - "-" only at the start.
 *
 * "12,000" depends on the interface language (RE-CLS-4): twelve thousand
 * in Chinese and English, 12 in Russian and Uzbek, where digits are grouped
 * with spaces and the comma is the decimal mark.
 *
 * R2-ORD-2 / R2-CLS-3 (2026-10-31): anything else is refused, not guessed.
 * Letters, a second decimal point or misplaced group marks used to be
 * stripped — "1e3" became 13, "1.2.3" 1.23, "12kg" 12 — and the field
 * silently held a number nobody typed. `readDecimalText` now says
 * `ok: false` and the field shows why.
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

function currentLocale(): string {
  return (
    decimalLocale ?? (typeof document !== 'undefined' ? document.documentElement.lang : '') ?? ''
  );
}

/** zh / en group digits with commas; ru / uz with spaces (or dots). */
function commaGroupsThousands(): boolean {
  return /^(zh|en)\b/i.test(currentLocale());
}

export type DecimalRead = { ok: true; value: string } | { ok: false };

const GROUPED = { ',': /^\d{1,3}(,\d{3})+$/, '.': /^\d{1,3}(\.\d{3})+$/ } as const;

/**
 * Reads a whole field: `{ ok: true, value }` with a plain decimal string
 * ("" for an empty field, and partial input such as "12." kept as typed),
 * or `{ ok: false }` when the text is not one number.
 */
export function readDecimalText(raw: string): DecimalRead {
  let text = raw.replace(/[\s\u00a0\u202f]/g, '');
  if (text === '') return { ok: true, value: '' };
  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);
  if (!/^[\d.,]+$/.test(text)) return { ok: false };
  const commas = text.split(',').length - 1;
  const dots = text.split('.').length - 1;
  let plain: string;
  if (commas > 0 && dots > 0) {
    // Both marks: the last one is the decimal mark (used once); the other
    // may only group the whole part in threes.
    const decimal = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    const at = text.lastIndexOf(decimal);
    const whole = text.slice(0, at);
    const fraction = text.slice(at + 1);
    if (text.split(decimal).length - 1 !== 1 || fraction.includes(group)) return { ok: false };
    if (!GROUPED[group].test(whole)) return { ok: false };
    plain = `${whole.split(group).join('')}.${fraction}`;
  } else if (commas > 0) {
    if (commaGroupsThousands() && GROUPED[','].test(text)) plain = text.replace(/,/g, '');
    else if (commas === 1) plain = text.replace(',', '.');
    else return { ok: false };
  } else if (dots > 1) {
    // "1.000.000" groups thousands with dots in Russian / Uzbek writing.
    if (!commaGroupsThousands() && GROUPED['.'].test(text)) plain = text.replace(/\./g, '');
    else return { ok: false };
  } else {
    plain = text;
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(plain)) return { ok: false };
  return { ok: true, value: (negative ? '-' : '') + plain };
}

/**
 * The normalised value of a field, or the text as typed (spaces dropped)
 * when it is not one number — never a guess. See readDecimalText.
 */
export function normalizeDecimalInput(raw: string): string {
  const read = readDecimalText(raw);
  return read.ok ? read.value : raw.replace(/[\s\u00a0\u202f]/g, '');
}
