import { describe, expect, test } from 'bun:test';
import { stableJson } from '../stableJson';

describe('stableJson', () => {
  test('object keys are sorted at every depth; arrays keep their order', () => {
    expect(stableJson({ b: 1, a: [3, { d: 1, c: 2 }, 1] })).toBe('{"a":[3,{"c":2,"d":1},1],"b":1}');
    expect(stableJson({ ru: 'а', en: 'a' })).toBe(stableJson({ en: 'a', ru: 'а' }));
  });

  test('an undefined property is left out, as JSON leaves it out', () => {
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }));
    expect(stableJson([undefined])).toBe('[null]');
    expect(stableJson(undefined)).toBe('null');
  });

  test('a Date is its ISO string', () => {
    expect(stableJson({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
  });
});
