/**
 * ADM2-06 (2026-11-09): an edit's audit row lists what changed, from what
 * to what.
 */
import { describe, expect, test } from 'bun:test';
import { auditChangeLines, type ChangeFormat } from '../auditChangeLines';

const fmt: ChangeFormat = {
  empty: '—',
  localName: (names) => names.en ?? Object.values(names)[0] ?? '',
  unit: (code) => `unit(${code})`,
  paymentMethod: (method) => `pay(${method})`,
  active: (on) => (on ? 'active' : 'paused'),
};

describe('auditChangeLines', () => {
  test('one line per changed field, in the order the form shows them', () => {
    // As Postgres returns them: jsonb orders keys by length, not as written.
    const inputs = {
      skuId: 'k1',
      names: { en: 'Cherry tomato' },
      changes: {
        step: ['0.5', '1'],
        unit: ['kg', 'box'],
        names: [{ en: 'Tomato', ru: 'Помидор' }, { en: 'Cherry tomato' }],
      },
    };
    expect(auditChangeLines(inputs, fmt)).toEqual([
      { field: 'admin.field.name', before: 'Tomato', after: 'Cherry tomato' },
      { field: 'admin.field.unit', before: 'unit(kg)', after: 'unit(box)' },
      { field: 'admin.field.step', before: '0.5', after: '1' },
    ]);
  });

  test('empty values, a store status, a payment method and a category', () => {
    const inputs = {
      changes: {
        address: [null, 'Navoi 5'],
        isActive: [true, false],
        defaultPaymentMethod: ['cash', 'transfer'],
        category: [null, { en: 'Vegetables' }],
      },
    };
    expect(auditChangeLines(inputs, fmt)).toEqual([
      { field: 'admin.field.category', before: '—', after: 'Vegetables' },
      { field: 'admin.field.defaultPaymentMethod', before: 'pay(cash)', after: 'pay(transfer)' },
      { field: 'admin.field.address', before: '—', after: 'Navoi 5' },
      { field: 'ops.audit.field.status', before: 'active', after: 'paused' },
    ]);
  });

  test('rows from before, unknown fields and malformed pairs show nothing', () => {
    expect(auditChangeLines({ skuId: 'k1', names: { en: 'X' } }, fmt)).toEqual([]);
    expect(auditChangeLines(null, fmt)).toEqual([]);
    expect(
      auditChangeLines({ changes: { secret: ['a', 'b'], name: ['only one'], code: 'x' } }, fmt),
    ).toEqual([]);
  });
});
