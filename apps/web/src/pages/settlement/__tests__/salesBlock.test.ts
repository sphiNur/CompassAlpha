import { describe, expect, test } from 'bun:test';
import { salesBlockLayout } from '../salesBlock';

describe('salesBlockLayout (UX-25)', () => {
  test('no sales block without sales.record', () => {
    expect(salesBlockLayout({ canRecordSales: false, dishCount: 0 })).toBe('none');
    expect(salesBlockLayout({ canRecordSales: false, dishCount: 3 })).toBe('none');
    expect(salesBlockLayout({ canRecordSales: false, dishCount: undefined })).toBe('none');
  });

  test('one line when the workspace has no dish', () => {
    expect(salesBlockLayout({ canRecordSales: true, dishCount: 0 })).toBe('noDishes');
  });

  test('the full panel with dishes, or while they are unknown', () => {
    expect(salesBlockLayout({ canRecordSales: true, dishCount: 1 })).toBe('full');
    expect(salesBlockLayout({ canRecordSales: true, dishCount: undefined })).toBe('full');
  });
});
