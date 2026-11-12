/**
 * The .xlsx writer (services/xlsx.ts, used by the attendance month
 * export): the zip it stores, read back as an unzip tool reads it, and
 * the cells and sheet names in its XML. The export's own rows are tested
 * in attendance-export.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { buildXlsx, cellText, columnName, crc32, zipStored } from '../services/xlsx';

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Every entry of a zip written with `zipStored`, read the way an unzip
 * tool does: through the central directory, each entry checked against
 * its local header, its size and a CRC from node:zlib (not the writer's
 * own `crc32`). A wrong offset, size or checksum fails here (TEST2-21).
 */
function readStoredZip(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  expect(at + view.getUint32(end + 12, true)).toBe(end);
  const entries = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = utf8.decode(zip.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint16(local + 8, true)).toBe(0); // stored, not compressed
    expect([view.getUint32(local + 14, true), view.getUint32(local + 18, true)]).toEqual([
      crc,
      size,
    ]);
    expect(view.getUint32(local + 22, true)).toBe(size);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    expect(data.length).toBe(size);
    expect(zlibCrc32(data) >>> 0).toBe(crc);
    entries.set(name, utf8.decode(data));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  expect(entries.size).toBe(count);
  return entries;
}

describe('xlsx writer', () => {
  test('crc32 matches the reference value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('column names', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  test('zip has a local header per file and one end record', () => {
    const z = zipStored([
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'b/c.txt', data: new Uint8Array() },
    ]);
    const view = new DataView(z.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(z.length - 22 + 10, true)).toBe(2);
  });

  test('cells are escaped, numbers stay numbers, sheet names are made legal', () => {
    const bytes = buildXlsx([
      {
        name: 'a/b:c*d?e[f]g with a very long name past 31',
        header: ['Name', 'Owed'],
        rows: [['<Ali & "Vali">', 123.45], [null, null]],
        moneyColumns: [1],
      },
    ]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('&lt;Ali &amp; &quot;Vali&quot;&gt;');
    expect(text).toContain('<c r="B2" s="2"><v>123.45</v></c>');
    expect(text).toContain('<sheet name="a b c d e f g with a very long"');
    expect(text).toContain('state="frozen"');
  });

  test('text that a spreadsheet would read as a formula gets an apostrophe (ATT-26)', () => {
    expect(['=SUM(A1:A9)', '+998', '-1', '@cmd', '\t=1', '\r=1'].map(cellText)).toEqual([
      "'=SUM(A1:A9)",
      "'+998",
      "'-1",
      "'@cmd",
      "'\t=1",
      "'\r=1",
    ]);
    // Only at the start, and plain text stays as typed.
    expect(['Ali', 'a=b', '09:00–18:00', '—', ''].map(cellText)).toEqual([
      'Ali',
      'a=b',
      '09:00–18:00',
      '—',
      '',
    ]);
    const sheet = readStoredZip(
      buildXlsx([
        {
          name: 'Days',
          header: ['Name', 'Reason', 'Worked'],
          rows: [['=HYPERLINK("x","y")', '\u0001@reason', -15]],
        },
      ]),
    ).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain(`<t xml:space="preserve">'=HYPERLINK(&quot;x&quot;,&quot;y&quot;)</t>`);
    // A control character before it is dropped first, then checked.
    expect(sheet).toContain(`<t xml:space="preserve">'@reason</t>`);
    // Numbers stay numbers, negative ones too.
    expect(sheet).toContain('<c r="C2"><v>-15</v></c>');
  });

  test('every entry reads back with its own size and checksum', () => {
    const z = zipStored([
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'b/c.txt', data: new Uint8Array() },
      { name: 'd.txt', data: new TextEncoder().encode('Salom, doʻstim. Привет. 你好。') },
    ]);
    expect([...readStoredZip(z)]).toEqual([
      ['a.txt', 'hello'],
      ['b/c.txt', ''],
      ['d.txt', 'Salom, doʻstim. Привет. 你好。'],
    ]);
  });

  test('Russian, Uzbek and Chinese names and text survive the round trip', () => {
    // People and stores have such names; in UTF-8 they are 2 or 3 bytes a
    // letter, so a size counted in letters would cut the file short.
    const entries = readStoredZip(
      buildXlsx([
        {
          name: 'Табель — Oʻrinboy 考勤表',
          header: ['Сотрудник', 'Xodim', '员工'],
          rows: [['Ғайрат Тошматов', 'Oʻrinboy Gʻaniyev', '张伟']],
        },
      ]),
    );
    expect(entries.get('xl/workbook.xml')).toContain('<sheet name="Табель — Oʻrinboy 考勤表"');
    const sheet = entries.get('xl/worksheets/sheet1.xml')!;
    for (const text of [
      'Сотрудник',
      'Xodim',
      '员工',
      'Ғайрат Тошматов',
      'Oʻrinboy Gʻaniyev',
      '张伟',
    ]) {
      expect(sheet).toContain(`<t xml:space="preserve">${text}</t>`);
    }
  });

  test('a sheet name is cut at 31 letters, not 31 bytes', () => {
    const name = 'Ежемесячный табель учёта рабочего времени';
    const entries = readStoredZip(buildXlsx([{ name, header: ['A'], rows: [] }]));
    expect(entries.get('xl/workbook.xml')).toContain(
      '<sheet name="Ежемесячный табель учёта рабоче"',
    );
  });
});
