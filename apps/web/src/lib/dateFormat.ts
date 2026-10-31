/**
 * Locale-bound date formatting, shared by `useDateFormat` (2026-10-31).
 *
 * Pure — no React, no store — so the formats can be tested directly. The
 * hook in hooks/useI18n.ts binds these to the session's language.
 *
 * D16: dates on screen follow the UI language. Run titles, approval cards
 * and history headers used to print the stored business date as is
 * ("2026-10-31", or "10-31" with the year cut off), the same in all four
 * languages; they now go through `calendarDay`.
 */
import type { Locale } from '@compass/i18n';

// ORD-19 (2026-10-30): where the runtime has no Uzbek data, Intl falls
// back to a bare pattern ("M10 30, Fri"). Then format Uzbek (Latin) by
// hand, following CLDR's uz patterns; runtimes that know uz are untouched.
const UZ_MONTHS = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentyabr', 'oktyabr', 'noyabr', 'dekabr'];
const UZ_MONTHS_SHORT = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
const UZ_WEEKDAYS = ['yakshanba', 'dushanba', 'seshanba', 'chorshanba', 'payshanba', 'juma', 'shanba'];

function uzFallback(opts: Intl.DateTimeFormatOptions): (d: Date) => string {
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (opts.weekday) return (d) => `${UZ_WEEKDAYS[d.getDay()]}, ${d.getDate()}-${UZ_MONTHS[d.getMonth()]}`;
  if (opts.month === 'long') return (d) => `${UZ_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (opts.month === 'short') {
    return (d) =>
      `${d.getDate()}-${UZ_MONTHS_SHORT[d.getMonth()]}` +
      (opts.year ? `, ${d.getFullYear()}` : '') +
      (opts.hour ? `, ${hhmm(d)}` : '');
  }
  return hhmm;
}

let uzProbe: boolean | null = null;
function intlKnowsUzbek(): boolean {
  if (uzProbe === null) {
    try {
      uzProbe = new Intl.DateTimeFormat('uz', { month: 'long' })
        .format(new Date(2020, 0, 15))
        .toLowerCase()
        .includes('yanvar');
    } catch {
      uzProbe = false;
    }
  }
  return uzProbe;
}

/**
 * A stored business date ("2026-10-31") as a local calendar day. `new
 * Date('2026-10-31')` is UTC midnight, which is the day before anywhere
 * west of Greenwich; the parts are the date, so build it locally.
 */
function toDate(v: Date | string | number): Date {
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return v instanceof Date ? v : new Date(v);
}

export type DateValue = Date | string | number | null | undefined;

export function makeDateFormatters(locale: Locale, now: () => Date = () => new Date()) {
  // supportedLocalesOf can claim uz while formatting still falls back,
  // so probe a real month name instead.
  const handFormatUz = locale === 'uz' && !intlKnowsUzbek();
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    const f = handFormatUz ? { format: uzFallback(opts) } : new Intl.DateTimeFormat(locale, opts);
    return (v: DateValue): string => {
      if (v === null || v === undefined || v === '') return '';
      const d = toDate(v);
      return Number.isNaN(d.getTime()) ? '' : f.format(d);
    };
  };
  const dayThisYear = fmt({ month: 'short', day: 'numeric' });
  const date = fmt({ year: 'numeric', month: 'short', day: 'numeric' });
  return {
    /** "2026年7月30日星期四" / "Thursday, July 30" — order-review subtitle. */
    weekdayLong: fmt({ weekday: 'long', month: 'long', day: 'numeric' }),
    /** "2026年6月" / "June 2026" — run-history month group header. */
    monthYear: fmt({ month: 'long', year: 'numeric' }),
    /** Calendar date only. */
    date,
    /**
     * A business date in a title or a card line: "10月31日" / "Oct 31" /
     * "31 окт." / "31-okt", with the year only when it is not this year.
     */
    calendarDay: (v: DateValue): string => {
      if (v === null || v === undefined || v === '') return '';
      const d = toDate(v);
      if (Number.isNaN(d.getTime())) return '';
      return d.getFullYear() === now().getFullYear() ? dayThisYear(d) : date(d);
    },
    /** Date + HH:MM — audit rows, sales rows. */
    dateTime: fmt({
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    /** HH:MM only. */
    time: fmt({ hour: '2-digit', minute: '2-digit' }),
  };
}
