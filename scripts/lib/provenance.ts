/**
 * Review OPS-05 and OPS-06 (2026-11): what deploy.ts's provenance gates
 * read from GitHub and from the live site, and what they make of it. The
 * readers take their `gh` and `fetch`, so the tests can hand them fakes
 * (scripts/__tests__/provenance.test.ts).
 */
import { spawnSync } from 'node:child_process';

/**
 * The CI jobs a release needs green: the `name:` of each job in
 * .github/workflows/ci.yml. A test checks that the file still has them.
 */
export const CI_JOBS = [
  'type-check + unit tests',
  'integration tests (Postgres)',
  'end-to-end (Playwright)',
] as const;

/** One GitHub check run, as `gh api …/commits/<sha>/check-runs` lists it. */
export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Why a commit does not count as tested, from its check runs, or null when
 * the newest run of every CI job finished green. A job can run more than
 * once for a commit (a re-run, a pull request), and the newest run counts.
 */
export function ciProblem(
  runs: readonly CheckRun[],
  jobs: readonly string[] = CI_JOBS,
): string | null {
  const newest = new Map<string, CheckRun>();
  for (const run of runs) {
    const seen = newest.get(run.name);
    if (!seen || run.id > seen.id) newest.set(run.name, run);
  }
  const notGreen = jobs.flatMap((job) => {
    const run = newest.get(job);
    if (!run) return [`${job}: no run`];
    if (run.status !== 'completed') return [`${job}: ${run.status}`];
    if (run.conclusion !== 'success') return [`${job}: ${run.conclusion ?? 'no conclusion'}`];
    return [];
  });
  return notGreen.length === 0 ? null : `CI is not green for this commit (${notGreen.join('; ')})`;
}

/**
 * The release the site runs, from the JSON of /health/version: its short
 * sha, and whether it was deployed as checked (`--force` adds
 * `-unverified`). Null when the answer names no commit.
 */
export function liveRelease(body: unknown): { sha: string; verified: boolean } | null {
  const commit = (body as { commit?: unknown } | null)?.commit;
  if (typeof commit !== 'string') return null;
  const m = /^([0-9a-f]{7,40})(-unverified)?$/.exec(commit.trim());
  return m ? { sha: m[1]!, verified: !m[2] } : null;
}

/** Runs `gh` and returns its output, or throws with its error. */
export type Gh = (args: string[]) => string;

/**
 * `gh` in `cwd`, without a shell: cmd.exe would split the arguments. A gh
 * that gets no answer is stopped after `timeoutMs`, instead of holding the
 * deploy up for good (review OPS-07).
 */
export function runGh(cwd: string, timeoutMs = 60_000): Gh {
  return (ghArgs) => {
    const r = spawnSync('gh', ghArgs, { cwd, encoding: 'utf8', timeout: timeoutMs });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      throw new Error(`no answer within ${timeoutMs / 1000} s`);
    }
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(r.stderr.trim() || `gh exited ${r.status}`);
    return r.stdout;
  };
}

/**
 * Why CI does not vouch for commit `sha` (see ciProblem), or null. Not
 * being able to read the result is a problem too: no `gh`, not logged in,
 * no network.
 */
export function ciProblemFor(sha: string, gh: Gh): string | null {
  try {
    const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
    const runs = gh([
      'api',
      '--paginate',
      `repos/${repo}/commits/${sha}/check-runs`,
      '--jq',
      '.check_runs[] | {id, name, status, conclusion} | @json',
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CheckRun);
    return ciProblem(runs);
  } catch (err) {
    const why = String((err as Error).message ?? err).split('\n')[0];
    return `could not read the CI result for this commit (gh: ${why})`;
  }
}

/** The release `base` runs (see liveRelease), or null when it does not answer. */
export async function liveReleaseAt(
  base: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sha: string; verified: boolean } | null> {
  try {
    const res = await fetchImpl(`${base}/health/version`, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? liveRelease(await res.json()) : null;
  } catch {
    return null;
  }
}
