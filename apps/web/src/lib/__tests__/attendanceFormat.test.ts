import { describe, expect, test } from 'bun:test';
import { sheetMemberOrder } from '../attendanceFormat';

// 2026-11-13: the attendance screens listed people in the server's own
// collation, so Chinese names came out in code-point order (张, 李, 王).
describe('sheetMemberOrder', () => {
  const people = [
    { name: '张三', enabled: true },
    { name: '王五', enabled: false },
    { name: '李四', enabled: true },
    { name: '赵六', enabled: false },
  ];

  test('attendance switched on first, then by name in the UI language', () => {
    const order = (locale: string) => [...people].sort(sheetMemberOrder(locale)).map((p) => p.name);
    expect(order('zh')).toEqual(['李四', '张三', '王五', '赵六']);
    expect(order('en')).toEqual(['张三', '李四', '王五', '赵六']);
  });
});
