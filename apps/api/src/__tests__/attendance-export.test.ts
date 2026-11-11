/**
 * The month's attendance workbook (services/attendanceExport.ts), without a
 * database: an overnight shift's clock-out goes on the shift's row
 * (2026-11-10). It was looked up under the next date, which has no row, so
 * the row showed the hours worked but neither the clock-out nor the time
 * it was made.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { Locale } from '@compass/i18n';
import { attendanceMonthExport } from '../http/attendanceExport';
import { purposeKey } from '../infra/jwt';
import { monthWorkbook, type MonthSheet } from '../services/attendanceExport';

const NIGHT = '2026-11-09';
const MORNING = '2026-11-10';

const sheet: MonthSheet = {
  members: [{ memberId: 'm1', name: 'Night Cook', inStore: true, enabled: true }],
  shifts: [{ memberId: 'm1', date: NIGHT, start: '20:00', end: '23:00' }],
  punches: [
    {
      memberId: 'm1',
      date: NIGHT,
      day: NIGHT,
      kind: 'in',
      time: '19:58',
      source: 'self',
      voided: null,
    },
    {
      memberId: 'm1',
      date: MORNING,
      day: NIGHT,
      kind: 'out',
      time: '00:30',
      source: 'self',
      voided: null,
    },
  ],
  days: [
    {
      memberId: 'm1',
      date: NIGHT,
      plannedMinutes: 180,
      workedMinutes: 272,
      lateMinutes: 0,
      earlyMinutes: 0,
      flags: [],
      dailyWage: '100000',
      pay: { status: 'payable', deductionCents: 0, netCents: 10_000_000 },
    },
  ],
  overtime: [
    {
      memberId: 'm1',
      date: NIGHT,
      minutes: 90,
      reason: 'Stocktake after closing',
      status: 'pending',
    },
  ],
};

/** The rows of the workbook's last sheet (the daily one), as XML. */
async function dailyRows(of: MonthSheet = sheet, locale: Locale = 'en'): Promise<string[]> {
  const { bytes } = await monthWorkbook(of, locale);
  // Stored (uncompressed) zip: the sheet XML is readable as is.
  const text = new TextDecoder().decode(bytes);
  const daily = text.slice(text.lastIndexOf('<sheetData>'));
  return [...daily.matchAll(/<row r="\d+">[\s\S]*?<\/row>/g)].map((m) => m[0]);
}

describe('monthWorkbook: an overnight shift', () => {
  test("its clock-out is on the shift's row, with the date it was made on", async () => {
    const rows = await dailyRows();
    // A header and the one day; no row for the morning after.
    expect(rows).toHaveLength(2);
    const night = rows[1]!;
    expect(night).toContain(`>${NIGHT}<`);
    expect(night).toContain('>19:58<');
    expect(night).toContain(`>00:30 (${MORNING})<`);
    expect(night).toContain('>Stocktake after closing<');
  });

  test('in Chinese the brackets are full-width, with no space before them', async () => {
    const rows = await dailyRows(sheet, 'zh');
    expect(rows[1]).toContain(`>00:30（${MORNING}）<`);
  });

  test('entered by a manager, it carries both marks', async () => {
    const manual: MonthSheet = {
      ...sheet,
      punches: sheet.punches.map((p) =>
        p.kind === 'out' ? { ...p, source: 'manual' as const } : p,
      ),
    };
    expect((await dailyRows(manual, 'en'))[1]).toContain(`>00:30 (${MORNING}) (manual)<`);
    expect((await dailyRows(manual, 'zh'))[1]).toContain(`>00:30（${MORNING}）（补卡）<`);
  });
});

// 2026-11-13: the workbook sorted people in the server's own collation, so
// Chinese names came out in code-point order (张, 李, 王), not pinyin.
describe('monthWorkbook: the order of people', () => {
  test('by name in the workbook language; two people with one name stay apart', async () => {
    const day = sheet.days[0]!;
    const people = [
      ['m-zhang', '张三'],
      ['m-wang-b', '王五'],
      ['m-li', '李四'],
      ['m-wang-a', '王五'],
    ] as const;
    const of: MonthSheet = {
      members: people.map(([memberId, name]) => ({ memberId, name, inStore: true, enabled: true })),
      shifts: [],
      punches: [],
      days: people.flatMap(([memberId]) =>
        ['2026-11-02', '2026-11-01'].map((date) => ({ ...day, memberId, date })),
      ),
      overtime: [],
    };
    const rows = (await dailyRows(of, 'zh')).slice(1).map((row) => {
      const name = /(张三|李四|王五)</.exec(row)?.[1];
      const date = />(\d{4}-\d{2}-\d{2})</.exec(row)?.[1];
      return `${name} ${date}`;
    });
    expect(rows).toEqual([
      '李四 2026-11-01',
      '李四 2026-11-02',
      '王五 2026-11-01',
      '王五 2026-11-02',
      '王五 2026-11-01',
      '王五 2026-11-02',
      '张三 2026-11-01',
      '张三 2026-11-02',
    ]);
  });
});

describe('a download link that fails (review ATT-15)', () => {
  const http = new Hono().get('/files/attendance-month.xlsx', attendanceMonthExport);

  async function open(token: string, headers: Record<string, string> = {}) {
    const res = await http.request(`/files/attendance-month.xlsx?t=${token}`, { headers });
    return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  }

  test('an expired link says so in the language it was asked for in', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({
      sub: 'u',
      org: 'o',
      mid: 'm',
      storeId: 's',
      month: '2026-11',
      locale: 'zh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('attendance-month-export')
      .setIssuedAt(now - 600)
      .setExpirationTime(now - 300)
      .sign(purposeKey('attendance-month-export'));
    const page = await open(expired, { 'accept-language': 'ru' });
    expect(page.status).toBe(410);
    expect(page.type).toContain('charset=UTF-8');
    expect(page.text).toBe('下载链接已过期，请回到应用重新导出。');
  });

  test("a link that is not ours is answered in the browser's first language", async () => {
    const ru = await open('nope', { 'accept-language': 'ru-RU,ru;q=0.9,en;q=0.8' });
    expect(ru.status).toBe(410);
    expect(ru.text).toBe('Срок действия ссылки истёк. Выгрузите файл снова в приложении.');
    expect((await open('nope')).text).toBe(
      'This download link has expired. Export again from the app.',
    );
  });
});
