/**
 * Review OPS-05 and OPS-06 (2026-11): a deploy needs the tip of
 * origin/main, green CI for it, and no older release than the one live.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CI_JOBS,
  ciProblem,
  ciProblemFor,
  liveRelease,
  liveReleaseAt,
  type CheckRun,
  type Gh,
} from '../lib/provenance';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const green = (id: number, name: string): CheckRun => ({
  id,
  name,
  status: 'completed',
  conclusion: 'success',
});

describe('CI for the commit being deployed (OPS-06)', () => {
  test('every job green passes, whatever else ran', () => {
    const runs = [...CI_JOBS.map((job, i) => green(10 + i, job)), green(1, 'Dependabot')];
    expect(ciProblem(runs)).toBeNull();
  });

  test('a job still running, failed or missing is named', () => {
    const [unit, integration, e2e] = CI_JOBS;
    const problem = ciProblem([
      green(1, unit),
      { id: 2, name: integration, status: 'in_progress', conclusion: null },
      { id: 3, name: e2e, status: 'completed', conclusion: 'failure' },
    ]);
    expect(problem).toContain(`${integration}: in_progress`);
    expect(problem).toContain(`${e2e}: failure`);
    expect(problem).not.toContain(unit);
    expect(ciProblem([green(1, unit), green(2, integration)])).toContain(`${e2e}: no run`);
  });

  test('the newest run of a job counts', () => {
    const [unit, integration, e2e] = CI_JOBS;
    const failedThenRerun = [
      green(1, unit),
      green(2, integration),
      { id: 3, name: e2e, status: 'completed', conclusion: 'failure' },
      green(4, e2e),
    ];
    expect(ciProblem(failedThenRerun)).toBeNull();
    const greenThenFailed = [
      green(1, unit),
      green(2, integration),
      { id: 5, name: e2e, status: 'completed', conclusion: 'cancelled' },
      green(4, e2e),
    ];
    expect(ciProblem(greenThenFailed)).toContain(`${e2e}: cancelled`);
  });

  test('reads the check runs of that commit with gh', () => {
    const calls: string[][] = [];
    const gh: Gh = (args) => {
      calls.push(args);
      if (args[0] === 'repo') return 'owner/repo\n';
      return CI_JOBS.map((job, i) => JSON.stringify(green(i + 1, job))).join('\n') + '\n';
    };
    expect(ciProblemFor('abc123', gh)).toBeNull();
    expect(calls[1]).toContain('repos/owner/repo/commits/abc123/check-runs');
  });

  test('a gh that fails, or answers nonsense, is not a pass', () => {
    const missing: Gh = () => {
      throw new Error('spawnSync gh ENOENT');
    };
    expect(ciProblemFor('abc123', missing)).toBe(
      'could not read the CI result for this commit (gh: spawnSync gh ENOENT)',
    );
    const nonsense: Gh = (args) => (args[0] === 'repo' ? 'owner/repo' : 'not json');
    expect(ciProblemFor('abc123', nonsense)).toContain('could not read the CI result');
    const nothing: Gh = (args) => (args[0] === 'repo' ? 'owner/repo' : '');
    expect(ciProblemFor('abc123', nothing)).toContain('no run');
  });

  test('ci.yml still names each of those jobs', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    for (const job of CI_JOBS) expect(ci).toContain(`    name: ${job}\n`);
  });
});

describe('the release that is live (OPS-05)', () => {
  test('a checked release and a forced one', () => {
    expect(liveRelease({ commit: '543e49dc6e00', startedAt: 'x' })).toEqual({
      sha: '543e49dc6e00',
      verified: true,
    });
    expect(liveRelease({ commit: '543e49dc6e00-unverified' })).toEqual({
      sha: '543e49dc6e00',
      verified: false,
    });
  });

  test("the site's own answer, or null when it gives none", async () => {
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await liveReleaseAt('https://x', answer(200, { commit: 'abcdef1234567' }))).toEqual({
      sha: 'abcdef1234567',
      verified: true,
    });
    expect(await liveReleaseAt('https://x', answer(502, { commit: 'abcdef1234567' }))).toBeNull();
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await liveReleaseAt('https://x', down)).toBeNull();
  });

  test('anything that is not a commit is unknown', () => {
    expect(liveRelease({ commit: 'dev' })).toBeNull();
    expect(liveRelease({})).toBeNull();
    expect(liveRelease(null)).toBeNull();
    expect(liveRelease({ commit: '543e49d; rm -rf /' })).toBeNull();
  });
});
