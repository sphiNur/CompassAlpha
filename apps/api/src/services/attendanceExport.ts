/**
 * The month's attendance as an .xlsx (owner request 2026-11-05): one
 * summary row per person, and one row per person and day with the shift,
 * punches, late / early minutes, pay and overtime.
 *
 * A Telegram Mini App cannot save a blob, so the client asks for a
 * short-lived signed link (`attendance.exportLink`) and hands it to
 * Telegram's own download dialog; `GET /files/attendance-month.xlsx`
 * checks the link, the member's permission again, and returns the file.
 */
import { SignJWT, jwtVerify } from 'jose';
import { format, loadCatalog, type CatalogKey, type Locale } from '@compass/i18n';
import { purposeKey } from '../infra/jwt';
import { buildXlsx, type Cell, type SheetSpec } from './xlsx';

const AUDIENCE = 'attendance-month-export';
/** Its own key: the link is never a login (2026-11-07). */
const secret = purposeKey(AUDIENCE);

export interface ExportClaims {
  sub: string;
  org: string;
  mid: string;
  storeId: string;
  month: string;
  locale: Locale;
}

export async function signExportToken(claims: ExportClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

export async function verifyExportToken(token: string): Promise<ExportClaims> {
  const { payload } = await jwtVerify(token, secret, { audience: AUDIENCE });
  return payload as unknown as ExportClaims;
}

/** First and last date of a YYYY-MM month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** What the workbook needs from the attendance sheet. */
export interface MonthSheet {
  members: readonly { memberId: string; name: string; inStore: boolean; enabled: boolean }[];
  shifts: readonly { memberId: string; date: string; start: string; end: string }[];
  punches: readonly {
    memberId: string;
    /** The day it was made on. */
    date: string;
    /** The day it counts for: an overnight shift keeps its early-morning out. */
    day: string;
    kind: 'in' | 'out';
    time: string;
    source: 'self' | 'manual';
    voided: unknown;
    face?: { result: 'match' | 'mismatch' | 'enrolled' | 'unchecked' } | null;
    liveness?: 'pass' | 'fail' | 'unchecked' | 'passive' | null;
    viaName?: string | null;
    faceLikeName?: string | null;
    newDevice?: boolean;
  }[];
  days: readonly {
    memberId: string;
    date: string;
    plannedMinutes: number;
    workedMinutes: number;
    lateMinutes: number;
    earlyMinutes: number;
    flags: readonly string[];
    dailyWage: string | null;
    pay: {
      status: 'payable' | 'absent' | 'needsReview' | 'inProgress' | 'noRate';
      deductionCents: number;
      netCents: number | null;
    };
  }[];
  overtime: readonly {
    memberId: string;
    date: string;
    minutes: number;
    reason: string | null;
    status: 'pending' | 'approved' | 'rejected';
  }[];
}

const money = (cents: number) => Math.round(cents) / 100;

/** The day's attendance in words, most telling first; empty = as planned. */
const FLAG_ORDER = [
  'absent',
  'missedShift',
  'missingIn',
  'missingOut',
  'unscheduled',
  'late',
  'early',
  'onDuty',
  'upcoming',
] as const;

export async function monthWorkbook(
  sheet: MonthSheet,
  locale: Locale,
): Promise<{ bytes: Uint8Array }> {
  await Promise.all([loadCatalog(locale), loadCatalog('en')]);
  const t = (key: string, vars?: Record<string, string | number>) =>
    format(`attendance.export.${key}` as CatalogKey, locale, vars);
  const name = new Map(sheet.members.map((m) => [m.memberId, m.name]));
  const key = (memberId: string, date: string) => `${memberId}|${date}`;

  const shiftsBy = new Map<string, string[]>();
  for (const sh of sheet.shifts) {
    const k = key(sh.memberId, sh.date);
    shiftsBy.set(k, [...(shiftsBy.get(k) ?? []), `${sh.start}–${sh.end}`]);
  }
  const punchesBy = new Map<string, { in: string[]; out: string[] }>();
  const faceBy = new Map<string, Set<string>>();
  // Liveness failed, a colleague's phone, a new phone (2026-11-06).
  const checksBy = new Map<string, Set<string>>();
  for (const p of sheet.punches) {
    if (p.voided) continue;
    // 2026-11-10: on the row of the day it counts for, as in the app. A
    // clock-out past midnight was looked up under the next date, which
    // has no row, so the shift's row lost it.
    const k = key(p.memberId, p.day);
    if (p.face) faceBy.set(k, new Set([...(faceBy.get(k) ?? []), p.face.result]));
    const checks = checksBy.get(k) ?? new Set<string>();
    if (p.liveness === 'fail') checks.add(t('check.livenessFailed'));
    if (p.viaName) checks.add(t('check.borrowed', { name: p.viaName }));
    if (p.faceLikeName) checks.add(t('check.faceLike', { name: p.faceLikeName }));
    if (p.newDevice) checks.add(t('check.newDevice'));
    if (checks.size > 0) checksBy.set(k, checks);
    const slot = punchesBy.get(k) ?? { in: [], out: [] };
    // Made on another day than the row's: that date too, as in the app.
    // The catalog sets brackets and spacing (Chinese: 00:30（2026-11-10）).
    const time =
      p.date === p.day
        ? p.time
        : format('attendance.sheet.madeOn', locale, { label: p.time, date: p.date });
    slot[p.kind].push(p.source === 'manual' ? t('manualMark', { time }) : time);
    punchesBy.set(k, slot);
  }
  const overtimeBy = new Map<string, MonthSheet['overtime'][number][]>();
  for (const o of sheet.overtime) {
    const k = key(o.memberId, o.date);
    overtimeBy.set(k, [...(overtimeBy.get(k) ?? []), o]);
  }

  const days = [...sheet.days].sort(
    (a, b) =>
      (name.get(a.memberId) ?? '').localeCompare(name.get(b.memberId) ?? '') ||
      a.date.localeCompare(b.date),
  );

  const dayRows: Cell[][] = days.map((d) => {
    const k = key(d.memberId, d.date);
    const punches = punchesBy.get(k);
    const ot = overtimeBy.get(k) ?? [];
    const settled = d.pay.status === 'payable' || d.pay.status === 'absent';
    return [
      d.date,
      name.get(d.memberId) ?? '—',
      (shiftsBy.get(k) ?? []).join(', ') || null,
      punches?.in.join(', ') || null,
      punches?.out.join(', ') || null,
      d.plannedMinutes,
      d.workedMinutes,
      d.lateMinutes || null,
      d.earlyMinutes || null,
      FLAG_ORDER.filter((f) => d.flags.includes(f))
        .map((f) => t(`flag.${f}`))
        .join(', ') || t('flag.ok'),
      [...(faceBy.get(k) ?? [])].map((r) => t(`face.${r}`)).join(', ') || null,
      [...(checksBy.get(k) ?? [])].join(', ') || null,
      t(`status.${d.pay.status}`),
      d.dailyWage === null ? null : Number(d.dailyWage),
      settled ? money(d.pay.deductionCents) : null,
      d.pay.netCents === null ? null : money(d.pay.netCents),
      ot.reduce((n, o) => n + o.minutes, 0) || null,
      ot.map((o) => t(`overtime.${o.status}`)).join(', ') || null,
      ot
        .map((o) => o.reason ?? '')
        .filter(Boolean)
        .join(' / ') || null,
    ];
  });

  type Total = {
    scheduled: number;
    worked: number;
    absent: number;
    review: number;
    lateTimes: number;
    late: number;
    early: number;
    workedMin: number;
    deduction: number;
    net: number;
    otApproved: number;
    otPending: number;
  };
  const totals = new Map<string, Total>();
  const total = (id: string) => {
    let v = totals.get(id);
    if (!v) {
      v = {
        scheduled: 0,
        worked: 0,
        absent: 0,
        review: 0,
        lateTimes: 0,
        late: 0,
        early: 0,
        workedMin: 0,
        deduction: 0,
        net: 0,
        otApproved: 0,
        otPending: 0,
      };
      totals.set(id, v);
    }
    return v;
  };
  for (const d of sheet.days) {
    const v = total(d.memberId);
    if (d.plannedMinutes > 0) v.scheduled++;
    if (d.workedMinutes > 0) v.worked++;
    if (d.flags.includes('absent')) v.absent++;
    if (['missingIn', 'missingOut', 'unscheduled'].some((f) => d.flags.includes(f))) v.review++;
    if (d.lateMinutes > 0) v.lateTimes++;
    v.late += d.lateMinutes;
    v.early += d.earlyMinutes;
    v.workedMin += d.workedMinutes;
    if (d.pay.status === 'payable') v.deduction += d.pay.deductionCents;
    if (d.pay.netCents !== null) v.net += d.pay.netCents;
  }
  for (const o of sheet.overtime) {
    const v = total(o.memberId);
    if (o.status === 'approved') v.otApproved += o.minutes;
    if (o.status === 'pending') v.otPending += o.minutes;
  }
  const summaryRows: Cell[][] = [...totals.entries()]
    .sort((a, b) => (name.get(a[0]) ?? '').localeCompare(name.get(b[0]) ?? ''))
    .map(([id, v]) => [
      name.get(id) ?? '—',
      v.scheduled,
      v.worked,
      v.absent,
      v.review,
      v.lateTimes,
      v.late,
      v.early,
      Math.round((v.workedMin / 60) * 100) / 100,
      money(v.deduction),
      money(v.net),
      v.otApproved,
      v.otPending,
    ]);

  const summary: SheetSpec = {
    name: t('sheetSummary'),
    widths: [18, 10, 10, 10, 12, 10, 12, 12, 12, 12, 14, 14, 14],
    header: [
      t('col.name'),
      t('col.daysScheduled'),
      t('col.daysWorked'),
      t('col.daysAbsent'),
      t('col.daysReview'),
      t('col.lateTimes'),
      t('col.lateMinutes'),
      t('col.earlyMinutes'),
      t('col.workedHours'),
      t('col.deduction'),
      t('col.net'),
      t('col.overtimeApproved'),
      t('col.overtimePending'),
    ],
    rows: summaryRows,
    moneyColumns: [9, 10],
  };
  const detail: SheetSpec = {
    name: t('sheetDays'),
    widths: [12, 18, 14, 14, 14, 10, 10, 10, 10, 16, 14, 22, 14, 12, 12, 12, 10, 14, 30],
    header: [
      t('col.date'),
      t('col.name'),
      t('col.shift'),
      t('col.in'),
      t('col.out'),
      t('col.plannedMinutes'),
      t('col.workedMinutes'),
      t('col.lateMinutes'),
      t('col.earlyMinutes'),
      t('col.attendance'),
      t('col.face'),
      t('col.checks'),
      t('col.status'),
      t('col.dailyWage'),
      t('col.deduction'),
      t('col.net'),
      t('col.overtimeMinutes'),
      t('col.overtimeStatus'),
      t('col.overtimeReason'),
    ],
    rows: dayRows,
    moneyColumns: [13, 14, 15],
  };
  return { bytes: buildXlsx([summary, detail]) };
}

/** The file's name, e.g. 「考勤-Store A-2026-11.xlsx」, safe for every OS. */
export async function exportFileName(
  locale: Locale,
  store: string,
  month: string,
): Promise<string> {
  await Promise.all([loadCatalog(locale), loadCatalog('en')]);
  const safeStore = store
    // Characters a file name cannot hold, control characters included.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, 60);
  return format('attendance.export.fileName', locale, { store: safeStore, month });
}

/** `attachment` with an ASCII fallback and the real (UTF-8) name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
