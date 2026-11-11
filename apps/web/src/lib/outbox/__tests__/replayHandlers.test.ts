/**
 * Review COREWEB2-29 (2026-11-12): every name in REPLAYED_PROCEDURES is a
 * mutation of the API, and a queued write's input is checked against that
 * mutation's input. tsc checks this file (tsconfig.test.json).
 */
import { describe, expect, it } from 'bun:test';
import { REPLAYED_PROCEDURES, type ReplayedInput, type ReplayedProcedure } from '../replayHandlers';

/** The listed names that are not mutations of the API: none. */
type NotAMutation = {
  [P in ReplayedProcedure]: [ReplayedInput<P>] extends [never] ? P : never;
}[ReplayedProcedure];

describe('replayed procedures', () => {
  it('are each listed once, and all are mutations of the API', () => {
    const allMutations: [NotAMutation] extends [never] ? true : NotAMutation = true;
    expect(allMutations).toBe(true);
    expect(new Set(REPLAYED_PROCEDURES).size).toBe(REPLAYED_PROCEDURES.length);
  });

  it('take the input of their own mutation', () => {
    // @ts-expect-error A purchase needs its run, item and quantity.
    const purchase: ReplayedInput<'run.purchaseItem'> = {};
    // @ts-expect-error An order line's quantity is a decimal string, as typed.
    const line: Partial<ReplayedInput<'order.adjustItem'>> = { qty: 2 };
    expect([purchase, line]).toHaveLength(2);
  });
});
