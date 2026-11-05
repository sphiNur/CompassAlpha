import { describe, expect, test } from 'bun:test';
import { buildXlsx, columnName, crc32, zipStored } from '../services/xlsx';
import { monthRange } from '../services/attendanceExport';

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

  test('month range', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});
