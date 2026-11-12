/**
 * The day a run's spend is booked under (2026-10-21 CA-03, HIS-7): a day
 * the calendar has, and not one still to come in the org's time zone. The
 * routers checked this themselves until review RUNAPI-13; the caller now
 * gives the domain the org's today.
 */
import { describe, expect, test } from 'bun:test';
import { decideRun, emptyRunState } from './index';
import { RUN_CLOCK as clock, planAndPurchase, planRun, runActor, runStepper } from '../testing';

const { step } = runStepper(clock);
const plannedItems = [{ skuId: 'sku-1', qty: '1' }];

describe('run date', () => {
  test('a new run is booked under today or an earlier day', () => {
    for (const runDate of ['2026-05-01', '2026-04-30']) {
      const [planned] = decideRun(
        emptyRunState('run-1'),
        planRun({ runDate, today: '2026-05-01', plannedItems }),
        clock,
      );
      if (planned?.type !== 'RunPlanned') throw new Error('expected RunPlanned');
      expect(planned.payload.runDate).toBe(runDate);
    }
  });

  test('a new run is not booked under a day still to come', () => {
    expect(() =>
      decideRun(
        emptyRunState('run-1'),
        planRun({ runDate: '2026-05-02', today: '2026-05-01', plannedItems }),
        clock,
      ),
    ).toThrow('run.errors.runDateInFuture');
  });

  test('a new run is not booked under a day the calendar does not have', () => {
    // 2026-02-31 would roll over into March; Postgres has no year 0.
    for (const runDate of ['2026-02-31', '2026-13-01', '0000-01-01', '26-01-01']) {
      expect(() =>
        decideRun(emptyRunState('run-1'), planRun({ runDate, plannedItems }), clock),
      ).toThrow('run.errors.invalidRunDate');
    }
  });

  test('the permission is checked before the date', () => {
    expect(() =>
      decideRun(
        emptyRunState('run-1'),
        planRun({ runDate: '2026-05-02', plannedItems, actor: runActor('x', []) }),
        clock,
      ),
    ).toThrow('run.errors.cannotCreate');
  });

  test('a run is moved to today or an earlier day, not to one still to come', () => {
    const amender = runActor('sa', ['run.amend']);
    const s = planAndPurchase();
    const move = (runDate: string) =>
      decideRun(s, { type: 'ChangeRunDate', runDate, today: '2026-05-03', actor: amender }, clock);
    expect(() => move('2026-05-04')).toThrow('run.errors.runDateInFuture');
    expect(move('2026-05-03')).toHaveLength(1);
    expect(
      step(s, { type: 'ChangeRunDate', runDate: '2026-04-28', today: '2026-05-03', actor: amender })
        .runDate,
    ).toBe('2026-04-28');
  });
});
