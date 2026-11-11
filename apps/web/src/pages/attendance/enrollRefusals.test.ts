import { describe, expect, test } from 'bun:test';
import { readRefusals } from './enrollRefusals';

describe('readRefusals (review ATT-27)', () => {
  test('each refused photo with its reason, in order', () => {
    expect(readRefusals({ problems: 'front:dark,left:blurry' })).toEqual([
      { pose: 'front', problem: 'dark' },
      { pose: 'left', problem: 'blurry' },
    ]);
  });

  test('a reason this version does not know keeps its line', () => {
    expect(readRefusals({ problems: 'right:glare,front2:spoof' })).toEqual([
      { pose: 'right', problem: 'unknown' },
      { pose: 'front2', problem: 'spoof' },
    ]);
  });

  test('a pose it does not know, or no list, gives no line', () => {
    expect(readRefusals({ problems: 'sideways:dark' })).toEqual([]);
    expect(readRefusals({ problems: 42 })).toEqual([]);
    expect(readRefusals({})).toEqual([]);
    expect(readRefusals(null)).toEqual([]);
    expect(readRefusals(undefined)).toEqual([]);
  });
});
