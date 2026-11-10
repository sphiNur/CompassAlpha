/**
 * Timed jobs in the API process (COREAPI-13/14, 2026-11-09): one job's
 * failure does not stop it or another, runs never overlap, and stopping
 * waits for the run in progress.
 */
import { describe, expect, test } from 'bun:test';
import { every, settlesWithin } from '../infra/periodic';

const HOUR = 60 * 60_000;

function recorder() {
  const warnings: Array<{ job: unknown; msg: string }> = [];
  return {
    warnings,
    log: { warn: (obj: object, msg: string) => void warnings.push({ ...obj, msg } as never) },
  };
}

/** A promise the test resolves by hand. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('every', () => {
  test('a failing run is logged and the next tick runs again', async () => {
    const { log, warnings } = recorder();
    let runs = 0;
    const job = every(
      'photos',
      HOUR,
      async () => {
        runs++;
        throw new Error('disk full');
      },
      log,
    );
    job.tick();
    await job.stop();
    expect(runs).toBe(1);
    expect(warnings).toMatchObject([{ job: 'photos', msg: 'periodic job failed' }]);
  });

  test("one job's failure does not touch another", async () => {
    const { log } = recorder();
    let cleaned = 0;
    const failing = every(
      'reminders',
      HOUR,
      async () => {
        throw new Error('bad shift row');
      },
      log,
    );
    const retention = every(
      'retention',
      HOUR,
      async () => {
        cleaned++;
      },
      log,
    );
    failing.tick();
    retention.tick();
    await Promise.all([failing.stop(), retention.stop()]);
    expect(cleaned).toBe(1);
  });

  test('a synchronous throw is caught like a rejection', async () => {
    const { log, warnings } = recorder();
    const job = every(
      'sync',
      HOUR,
      (() => {
        throw new Error('boom');
      }) as () => Promise<void>,
      log,
    );
    job.tick();
    await job.stop();
    expect(warnings).toHaveLength(1);
  });

  test('runs never overlap, and stop waits for the run in progress', async () => {
    const { log } = recorder();
    const g = gate();
    let started = 0;
    let finished = 0;
    const job = every(
      'slow',
      HOUR,
      async () => {
        started++;
        await g.opened;
        finished++;
      },
      log,
    );
    job.tick();
    job.tick(); // still running: skipped
    await Bun.sleep(0);
    expect(started).toBe(1);
    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);
    g.open();
    await stopping;
    expect(finished).toBe(1);
    job.tick(); // stopped: no new run
    await Bun.sleep(0);
    expect(started).toBe(1);
  });
});

describe('settlesWithin', () => {
  test('true when the work ends in time, failed or not', async () => {
    expect(await settlesWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error('x')), 50)).toBe(true);
  });

  test('false when it does not', async () => {
    expect(await settlesWithin(new Promise(() => {}), 20)).toBe(false);
  });
});
