/**
 * Review DB-08 (2026-11-10): a migration step whose lock wait runs out is
 * tried again a few times; anything else fails at once.
 */
import { describe, expect, test } from 'bun:test';
import { LOCK_RETRY_PAUSES_MS, isLockTimeout, retryOnLockTimeout } from '../migrateLocks';

const lockError = () =>
  Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

/** A step that fails with `errors` in turn, then returns 'done'. */
function failing(errors: unknown[]) {
  let calls = 0;
  return {
    step: async () => {
      calls += 1;
      const err = errors.shift();
      if (err) throw err;
      return 'done';
    },
    calls: () => calls,
  };
}

function quiet() {
  const slept: number[] = [];
  const lines: string[] = [];
  return {
    opts: {
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      log: (line: string) => lines.push(line),
    },
    slept,
    lines,
  };
}

describe('isLockTimeout', () => {
  test('the driver error, or the same error wrapped by drizzle', () => {
    expect(isLockTimeout(lockError())).toBe(true);
    expect(isLockTimeout(Object.assign(new Error('Failed query'), { cause: lockError() }))).toBe(
      true,
    );
  });

  test('any other error is not', () => {
    expect(isLockTimeout(Object.assign(new Error('deadlock'), { code: '40P01' }))).toBe(false);
    expect(isLockTimeout(new Error('boom'))).toBe(false);
    expect(isLockTimeout(undefined)).toBe(false);
    expect(isLockTimeout('55P03')).toBe(false);
  });
});

describe('retryOnLockTimeout', () => {
  test('a busy lock is waited out, with a line for each retry', async () => {
    const s = failing([lockError(), lockError()]);
    const q = quiet();
    expect(await retryOnLockTimeout('900_rls_policies.sql', s.step, q.opts)).toBe('done');
    expect(s.calls()).toBe(3);
    expect(q.slept).toEqual(LOCK_RETRY_PAUSES_MS.slice(0, 2));
    expect(q.lines).toHaveLength(2);
    expect(q.lines[0]).toContain('900_rls_policies.sql');
  });

  test('it gives up after the last pause', async () => {
    const s = failing([lockError(), lockError(), lockError()]);
    const q = quiet();
    await expect(
      retryOnLockTimeout('drizzle migrations', s.step, { ...q.opts, pausesMs: [1, 2] }),
    ).rejects.toMatchObject({ code: '55P03' });
    expect(s.calls()).toBe(3);
    expect(q.slept).toEqual([1, 2]);
  });

  test('any other failure is thrown at once', async () => {
    const s = failing([new Error('syntax error')]);
    const q = quiet();
    await expect(retryOnLockTimeout('x', s.step, q.opts)).rejects.toThrow('syntax error');
    expect(s.calls()).toBe(1);
    expect(q.slept).toEqual([]);
  });
});
