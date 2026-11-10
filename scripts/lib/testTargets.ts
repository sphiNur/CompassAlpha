/**
 * The directories the test runs cover (review OPS-16, 2026-11-10).
 *
 * The list was written out by hand in CI's unit job, in the deploy's unit
 * gate and in CLAUDE.md, and the copies drifted: packages/contracts was in
 * none of them, so limits.test.ts never ran, and the worker's PG-gated
 * tests ran only on a developer's machine. The deploy now reads the lists
 * from here, and scripts/__tests__/testTargets.test.ts fails when CI or
 * CLAUDE.md say otherwise, or when a test file sits outside every
 * directory a run covers.
 */

/** CI's unit job and the deploy's unit gate, run with SKIP_PG_TESTS=1. */
export const UNIT_TEST_DIRS = [
  'packages/domain',
  'packages/contracts',
  'packages/db',
  'packages/i18n',
  'packages/ui',
  'apps/api',
  'apps/worker',
  'apps/web/src',
  'scripts',
] as const;

/** CI's integration job, against a migrated Postgres. */
export const INTEGRATION_TEST_DIRS = [
  'apps/api/src/__tests__',
  'apps/api/src/services/__tests__',
  'apps/worker/src',
] as const;

/** Playwright specs, run by CI's e2e job from their own package. */
export const E2E_TEST_DIR = 'tests/e2e';

/** A file `bun test` runs: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`. */
export const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;

/** A test that runs only with a database: it reads SKIP_PG_TESTS or imports the API's PG gate. */
export const PG_GATED = /process\.env\.SKIP_PG_TESTS|helpers\/pg['"]/;

/** Whether `file` (repository-relative, forward slashes) is inside one of `dirs`. */
export function isUnder(file: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => file === d || file.startsWith(d + '/'));
}

/**
 * The directories `bun test` is given in the workflow step named `step`.
 * The step must run one `bun test` whose arguments are the directories,
 * one per line or on one line.
 */
export function ciTestDirs(workflow: string, step: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${step}`);
  if (start < 0) throw new Error(`no step named "${step}"`);
  const indent = lines[start]!.indexOf('-');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const lead = line.length - line.trimStart().length;
    // The next step of the job, or the next job.
    if (line.trim() !== '' && lead <= indent) break;
    body.push(line);
  }
  const command = body
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#'))
    .join(' ')
    .replace(/\\ /g, ' ');
  const m = /\bbun test\s+(.*)$/.exec(command);
  if (!m) throw new Error(`step "${step}" does not run bun test`);
  return m[1]!.split(/\s+/).filter((t) => t !== '' && t !== '\\');
}
