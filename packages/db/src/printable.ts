/**
 * Text from the database, made safe to print in the operator's terminal
 * (security scan F10, 2026-10-31).
 *
 * Store, supplier, category and SKU names are typed by tenant admins.
 * The maintenance scripts print them raw, so a name holding an escape
 * sequence (cursor up, erase line, fake text) could rewrite the row
 * counts an operator reads before passing `--apply`. Every C0/C1 control
 * character is shown as a visible `\uXXXX` instead; ordinary text,
 * including Cyrillic, Chinese and Uzbek letters, is left alone.
 */
export function printable(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    out +=
      c < 0x20 || (c >= 0x7f && c <= 0x9f) ? `\\u${c.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}
