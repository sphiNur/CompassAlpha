import { describe, expect, test } from 'bun:test';
import { auditChanges } from '../auditChanges';

describe('auditChanges (ADM2-06)', () => {
  test('keeps before and after of the fields the edit changed', () => {
    const before = { name: 'Tomato', unit: 'kg', code: 'T1', sortIndex: 3 };
    const patch = { name: 'Cherry tomato', unit: 'kg', sortIndex: 4, updatedAt: new Date() };
    expect(auditChanges(before, patch, ['name', 'unit', 'code', 'sortIndex'])).toEqual({
      name: ['Tomato', 'Cherry tomato'],
      sortIndex: [3, 4],
    });
  });

  test('padded decimals are the same number, and are kept unpadded', () => {
    expect(auditChanges({ step: '0.500' }, { step: '0.5' }, ['step'], ['step'])).toEqual({});
    expect(auditChanges({ step: '0.500' }, { step: '1' }, ['step'], ['step'])).toEqual({
      step: ['0.5', '1'],
    });
  });

  test('a code that looks like a number is still text', () => {
    expect(auditChanges({ code: '001' }, { code: '1' }, ['code'])).toEqual({ code: ['001', '1'] });
  });

  test('empty string and null are the same nothing', () => {
    expect(auditChanges({ address: null }, { address: '' }, ['address'])).toEqual({});
    expect(auditChanges({ address: 'Navoi 5' }, { address: '' }, ['address'])).toEqual({
      address: ['Navoi 5', null],
    });
  });

  test('names maps compare by content, not key order', () => {
    const before = { names: { ru: 'Помидор', en: 'Tomato' } };
    expect(auditChanges(before, { names: { en: 'Tomato', ru: 'Помидор' } }, ['names'])).toEqual({});
    expect(auditChanges(before, { names: { en: 'Tomatoes', ru: 'Помидор' } }, ['names'])).toEqual({
      names: [
        { ru: 'Помидор', en: 'Tomato' },
        { en: 'Tomatoes', ru: 'Помидор' },
      ],
    });
  });

  test('a field the edit leaves out is not compared', () => {
    expect(
      auditChanges({ name: 'A', isActive: true }, { isActive: undefined }, ['name', 'isActive']),
    ).toEqual({});
  });
});
