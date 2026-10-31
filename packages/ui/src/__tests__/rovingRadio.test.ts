import { describe, expect, test } from 'bun:test';
import { nextRadioIndex } from '../rovingRadio';

describe('nextRadioIndex (A11Y-15)', () => {
  test('arrows move by one and wrap around', () => {
    expect(nextRadioIndex(3, 0, 'ArrowRight')).toBe(1);
    expect(nextRadioIndex(3, 2, 'ArrowRight')).toBe(0);
    expect(nextRadioIndex(3, 2, 'ArrowDown')).toBe(0);
    expect(nextRadioIndex(3, 0, 'ArrowLeft')).toBe(2);
    expect(nextRadioIndex(3, 1, 'ArrowUp')).toBe(0);
  });

  test('Home and End go to the ends', () => {
    expect(nextRadioIndex(5, 3, 'Home')).toBe(0);
    expect(nextRadioIndex(5, 1, 'End')).toBe(4);
  });

  test('other keys and empty groups do nothing', () => {
    expect(nextRadioIndex(3, 1, 'Tab')).toBeNull();
    expect(nextRadioIndex(3, 1, ' ')).toBeNull();
    expect(nextRadioIndex(0, 0, 'ArrowRight')).toBeNull();
  });
});
