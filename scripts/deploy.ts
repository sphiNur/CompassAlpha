/**
 * One-button deploy + verify.
 *
 *   bun run scripts/deploy.ts                       # ship + verify
 *   bun run scripts/deploy.ts --dry                 # only verify; don't ship
 *   bun run scripts/deploy.ts --force               # ship an unreproducible tree
 *   bun run scripts/deploy.ts --allow-active-run    # ship during a live run
 *   bun run scripts/deploy.ts --allow-stale-backup  # ship without a recent backup
 *   bun run scripts/deploy.ts --skip-rls-check      # ship without the DB role check
 *   bun run scripts/deploy.ts --rollback --dry      # show the release a rollback would restore
 *   bun run scripts/deploy.ts --rollback            # put the previous release back + verify
 *
 * The two override flags exist because this script ships a WORKING
 * DIRECTORY rather than a git ref, and both gates protect against that:
 *
 *   --force            skips the provenance gates (clean tree, on main,
 *                      the tip of origin/main, green CI for it, not older
 *                      than the live release). The release sha is then
 *                      suffixed `-unverified` so /health/version cannot
 *                      claim a provenance the artifact does not have.
 *   --allow-active-run skips the check for a run in purchasing/delivering.
 *                      The api restart forces a reload on every live
 *                      client, which discards prices a purchaser has
 *                      typed but not yet committed.
 *
 * Two more skip a server check (review OPS-02, OPS-04, 2026-11):
 *
 *   --allow-stale-backup ships although the nightly backup looks broken
 *                      or could not be checked.
 *   --skip-rls-check   ships although step 0.8 could not confirm that the
 *                      database role is subject to row-level security.
 *
 * A check that cannot run stops the deploy, the same as a check that
 * fails (review OPS-03, OPS-04). It used to print a warning and go on, or
 * pass outright.
 *
 * Pipeline:
 *   0. Provenance gates (local) + no-active-run pre-flight (server)
 *   0.5 Unit tests (local) — a red suite stops here, before shipping
 *   1-2. rsync the changed files to a staging copy on the server and build
 *      the tarball there (2026-11-06: the link is slow and lossy); where
 *      rsync is missing (or on Windows), tar the local CompassAlpha
 *      sources (excl. node_modules / .env / .turbo / .git / .claude) and
 *      scp the whole tarball
 *   2.5 keep the live release as /home/ubuntu/compass-alpha.prev.tar.gz
 *      (the rollback target — see "Rollback" below)
 *   3. extract over /home/ubuntu/compass-alpha (in place; no downtime
 *      until the api restart in step 4c)
 *   4b. pnpm exec vite build --outDir dist.next, then swap it into place
 *      (dist → dist.prev, dist.next → dist). The api reads
 *      web/dist/build-id.txt for /health/version so running clients see
 *      a version mismatch and prompt reload.
 *   4c. systemctl restart compass-api compass-worker
 *   6. Run server-side tRPC smoke locally against the public URL
 *   7. Run browser smoke locally against the public URL
 *   8. If either fails, exit non-zero; the deploy is "live" but you know
 *      something's broken.
 *
 * Rollback (N9, 2026-10-30): `--rollback` ships nothing. It puts the
 * release kept in step 2.5 back over the live tree (code + web bundle;
 * the server's .env files are never part of it), reinstalls that
 * release's lockfile, refreshes the units, restarts api + worker and runs
 * the same checks as a deploy (steps 4c–8). It does NOT undo migrations
 * (see docs/RUNBOOK.md "Roll back a bad deploy"). Only one release is
 * kept: the next deploy replaces it with whatever is live at that moment.
 *
 * Host keys (N9): ssh/scp verify the server against
 * infra/deploy/known_hosts (override: COMPASS_DEPLOY_KNOWN_HOSTS) and
 * refuse a host that is not pinned there, or presents another key.
 *
 * The reason smoke runs LOCALLY hitting the PUBLIC URL: that's the same
 * code path real users take, including Cloudflare + nginx + the same
 * cached HTML headers. If it passes here it'll pass on the iPhone.
 *
 * NOT in this pipeline (one-time, separate install):
 *   - infra/backup/{compass-backup.sh,.service,.timer} — nightly Postgres
 *     backup. After the first deploy that ships infra/backup/, run on the
 *     server:
 *         sudo bash /home/ubuntu/compass-alpha/infra/backup/install.sh
 *     The installer symlinks the systemd units, so subsequent deploys
 *     pick up edits to the .sh / .service / .timer files automatically
 *     after a `sudo systemctl daemon-reload`. See docs/RUNBOOK.md
 *     "Backups" for verify + restore commands.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUntilReady } from './lib/liveSite';
import { ciProblemFor, liveReleaseAt, runGh } from './lib/provenance';
import {
  APP_DIR,
  PREV_TARBALL,
  STAGE_DIR,
  backupHealthScript,
  backupProblem,
  clearIncompleteScript,
  describeSnapshotScript,
  devBypassFiles,
  devBypassScript,
  hostName,
  knownHostsFile,
  markIncompleteScript,
  remoteCommand,
  restoreScript,
  rlsRoleProblem,
  rsyncExcludes,
  serverLimitSecs,
  snapshotScript,
  sshOptions,
  stageSeedScript,
  stageTarScript,
  tarExcludes,
} from './lib/deployRemote';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname); // .../CompassAlpha
const PARENT = dirname(ROOT); // .../gemini

/**
 * Deploy target (M3.18, launch hardening 2026-05-16).
 *
 * Previously HOST + KEY were hard-coded — the production IP entered
 * version control, and the SSH key was assumed to sit one dir up
 * from the repo. Both were findings in the launch audit. Now both
 * read from env, with a fallback to `~/.ssh/compass_alpha.pem`
 * (the recommended canonical location for the deploy key).
 *
 * Set these in your shell profile:
 *   export COMPASS_DEPLOY_HOST=ubuntu@compass-pro.com
 *   export COMPASS_DEPLOY_KEY=$HOME/.ssh/compass_alpha.pem
 */
const HOST = process.env.COMPASS_DEPLOY_HOST;
if (!HOST) {
  console.error(
    'COMPASS_DEPLOY_HOST is not set.\n' +
      '  Set: export COMPASS_DEPLOY_HOST=ubuntu@<host-or-ip>\n' +
      '  Example: export COMPASS_DEPLOY_HOST=ubuntu@compass-pro.com',
  );
  process.exit(2);
}
const KEY =
  process.env.COMPASS_DEPLOY_KEY ??
  join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ssh', 'compass_alpha.pem');
const TARBALL = join(PARENT, 'compass-alpha-deploy.tar.gz');
// MSYS2 tar on Windows sees `C:` and thinks it's a remote host. Use a
// relative path from PARENT to keep tar happy.
const TARBALL_RELATIVE = 'compass-alpha-deploy.tar.gz';

/**
 * The public URL the smokes test (they refuse to run without it). Review
 * OPS-05/OPS-08 (2026-11): read up front, so a deploy without it stops
 * before shipping instead of at the smoke, and the live release can be
 * read before anything changes.
 */
const BASE = process.env.COMPASS_BASE?.replace(/\/+$/, '');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const ROLLBACK = args.has('--rollback');
const KNOWN_HOSTS = knownHostsFile(ROOT);
const SSH_OPTS = sshOptions(KEY, KNOWN_HOSTS);

function step(label: string) {
  console.log(`\n\x1b[36m▶ ${label}\x1b[0m`);
}

/**
 * Review OPS-07 (2026-11): how long one command may take. Nothing had a
 * limit, and on the lossy link to the server a connection that died
 * quietly left the deploy hanging for good. A command that runs over is
 * killed and fails the step like any other failure. The ssh keepalives in
 * sshOptions() notice a dead connection within two minutes.
 */
const MINUTE = 60_000;
const LIMIT = {
  /** Local commands and a remote step: install, build, migrate, extract. */
  step: 20 * MINUTE,
  /** One rsync attempt over the slow link. */
  rsync: 30 * MINUTE,
  /** The whole tarball over the slow link (20+ minutes has happened). */
  scp: 60 * MINUTE,
  /** Each smoke. */
  smoke: 10 * MINUTE,
};

/** `err`, or for a command killed at its limit, an error that says so. */
function overLimit(err: unknown, cmd: string, limitMs: number): unknown {
  if ((err as NodeJS.ErrnoException).code !== 'ETIMEDOUT') return err;
  return new Error(`${cmd.split(' ')[0]} did not finish within ${limitMs / MINUTE} min`);
}
/** " (stopped after N min)" for a spawnSync child killed at its limit. */
function stoppedNote(child: { error?: Error }, limitMs: number): string {
  return (child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    ? ` (stopped after ${limitMs / MINUTE} min)`
    : '';
}

function run(cmd: string, opts?: { cwd?: string; quiet?: boolean; timeoutMs?: number }): void {
  if (!opts?.quiet) console.log(`  $ ${cmd}`);
  const timeout = opts?.timeoutMs ?? LIMIT.step;
  try {
    execSync(cmd, { cwd: opts?.cwd ?? ROOT, stdio: opts?.quiet ? 'pipe' : 'inherit', timeout });
  } catch (err) {
    throw overLimit(err, cmd, timeout);
  }
}
function runCapture(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): string {
  const timeout = opts?.timeoutMs ?? LIMIT.step;
  try {
    return execSync(cmd, { cwd: opts?.cwd ?? ROOT, encoding: 'utf8', timeout });
  } catch (err) {
    throw overLimit(err, cmd, timeout);
  }
}
/**
 * Run a command on the deploy host.
 *
 * The payload is base64'd rather than quoted (2026-07-26). `execSync`
 * spawns through the platform shell — cmd.exe on Windows, which is where
 * this script is actually run from — and cmd.exe does not understand the
 * POSIX quoting that `JSON.stringify` produces. Any remote command
 * containing a single quote was silently shredded into fragments that
 * cmd.exe then tried to execute as programs:
 *
 *     bash: -c: line 1: unexpected EOF while looking for matching `"'
 *     'run_index' is not recognized as an internal or external command
 *
 * Every affected caller happens to be a VERIFICATION step wrapped in
 * try/catch, so this failed OPEN: the dev-auth-bypass grep, the
 * BYPASSRLS probe and the in-flight-run pre-flight all logged a warning
 * about psql and let the deploy proceed. Checks that cannot run are
 * worse than no checks, because they read as green.
 *
 * Base64 puts nothing but [A-Za-z0-9+/=] on the command line, so no
 * shell on either side has anything to misparse.
 *
 * Review OPS-07 (2026-11): the server ends the step before this side
 * gives up on it, and runs one step at a time (remoteCommand()).
 */
function ssh(cmd: string, timeoutMs = LIMIT.step): string {
  const secs = serverLimitSecs(timeoutMs);
  try {
    return runCapture(`ssh ${SSH_OPTS} ${HOST} "${remoteCommand(cmd, secs)}"`, { timeoutMs });
  } catch (err) {
    if ((err as { status?: number }).status === 124) {
      throw new Error(`the server stopped this step after ${Math.round(secs / 6) / 10} min`);
    }
    throw err;
  }
}

/** rsync here and on the server (not on Windows: cmd.exe quoting, no rsync). */
function canRsync(): boolean {
  if (process.platform === 'win32') return false;
  if (spawnSync('rsync', ['--version'], { stdio: 'pipe' }).status !== 0) return false;
  try {
    ssh('command -v rsync');
    return true;
  } catch {
    return false;
  }
}

/**
 * Send the working tree to the staging copy. Files are compared by
 * checksum (-c): the seeded copy carries tar's whole-second times, and a
 * same-size edit within that second would otherwise look unchanged. The
 * link drops packets, so a broken transfer is resumed (--partial) up to
 * three times.
 */
function rsyncWithRetry(): void {
  const cmd = [
    'rsync -rlptzc --delete --delete-excluded --partial --stats',
    rsyncExcludes(),
    `-e 'ssh ${SSH_OPTS}'`,
    './',
    `${HOST}:${STAGE_DIR}/CompassAlpha/`,
  ].join(' ');
  for (let attempt = 1; ; attempt++) {
    try {
      const out = runCapture(cmd, { timeoutMs: LIMIT.rsync });
      const sent = out.match(/Total bytes sent: ([\d,.]+)/)?.[1];
      const files = out.match(/Number of regular files transferred: ([\d,.]+)/)?.[1];
      console.log(`  sent ${sent ?? '?'} bytes, ${files ?? '?'} files changed`);
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`  rsync attempt ${attempt} failed, retrying…`);
    }
  }
}

if (!existsSync(KEY)) {
  console.error(`SSH key not found at ${KEY}`);
  process.exit(2);
}

// N9 (2026-10-30): this used to pass StrictHostKeyChecking=no, so
// whatever answered on the deploy address got the session — and with it
// the production .env and sudo. Refuse up front, with a clear message,
// when the target is not pinned (ssh itself refuses a changed key).
{
  const pinned = spawnSync('ssh-keygen', ['-F', hostName(HOST), '-f', KNOWN_HOSTS], {
    stdio: 'pipe',
  });
  if (pinned.status !== 0) {
    console.error(`\x1b[31m✖ ${hostName(HOST)} has no pinned host key in ${KNOWN_HOSTS}.\x1b[0m`);
    console.error("  Get the server's key fingerprints from the provider console (not over");
    console.error('  the network you are deploying through), compare them with');
    console.error(`    ssh-keyscan ${hostName(HOST)} | ssh-keygen -lf -`);
    console.error('  and only then append the keyscan output to that file (or point');
    console.error('  COMPASS_DEPLOY_KNOWN_HOSTS at a file that has them).');
    process.exit(2);
  }
}

/**
 * `--rollback --dry`: say which release a rollback would restore, change
 * nothing. Read-only on the server.
 */
if (ROLLBACK && DRY) {
  step('rollback target (dry: nothing is changed)');
  try {
    console.log(ssh(describeSnapshotScript()));
  } catch (err) {
    console.error(`\x1b[31m✖ no usable previous release: ${(err as Error).message}\x1b[0m`);
    process.exit(1);
  }
  process.exit(0);
}

if (!BASE) {
  console.error('COMPASS_BASE is not set (the public URL the smokes test).');
  console.error('  Set: export COMPASS_BASE=https://<the public app URL>');
  process.exit(2);
}

/** Whether commit `a` is `b` or in its history (false when either is unknown). */
function isAncestor(a: string, b: string): boolean {
  return spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: ROOT }).status === 0;
}

/**
 * Provenance gates (2026-07-26).
 *
 * This script tars the WORKING DIRECTORY, not a git ref, and extracts it
 * server-side with `--strip-components=1` and no `--delete`. Three
 * consequences that bit us:
 *
 *   - uncommitted (or unpushed) code ships to production and exists
 *     nowhere else;
 *   - deploying from a different branch leaves the union of both trees
 *     on disk, because files deleted in the repo are never removed on
 *     the server (this is live right now: `main` split RunPage.tsx into
 *     apps/web/src/pages/runs/*, a branch that predates the split would
 *     restore the monolith and orphan the split tree beside it);
 *   - `/health/version` reports whatever HEAD said on the dev box, so a
 *     sha that looks clean can describe a tree nobody can reconstruct.
 *
 * So: refuse to ship anything that isn't a committed, pushed commit on
 * main. `--force` overrides for a genuine emergency, and when it does,
 * the release sha is suffixed so the version endpoint cannot claim a
 * provenance the artifact does not have.
 *
 * Review OPS-05/OPS-06 (2026-11): "pushed" meant "an ancestor of
 * origin/main", so a checkout that had not pulled shipped an older main
 * over the live one, and migrations do not go back. Now HEAD must be the
 * tip of origin/main as fetched now, CI must have passed for it, and the
 * live release must be in its history.
 */
async function provenanceGates(): Promise<string> {
  const gitBranch = runCapture('git rev-parse --abbrev-ref HEAD').trim();
  const gitDirty = runCapture('git status --porcelain').trim();
  const provenanceProblems: string[] = [];

  if (gitDirty) {
    provenanceProblems.push(
      `working tree is dirty (${gitDirty.split('\n').length} file(s)) — commit or stash first`,
    );
  }
  if (gitBranch !== 'main') {
    provenanceProblems.push(`HEAD is on "${gitBranch}", not main`);
  }
  try {
    execSync('git fetch origin main --quiet', { cwd: ROOT, stdio: 'pipe', timeout: 2 * MINUTE });
  } catch {
    provenanceProblems.push('could not fetch origin/main, so HEAD may not be the newest main');
  }
  const head = runCapture('git rev-parse HEAD').trim();
  const tip = runCapture('git rev-parse origin/main').trim();
  if (head !== tip) {
    provenanceProblems.push(
      isAncestor(head, tip)
        ? `HEAD is behind origin/main (${tip.slice(0, 12)}) — pull first`
        : 'HEAD is not on origin/main — push and merge it first',
    );
  }
  // The release the site runs must not be newer than this one. A forced
  // release (-unverified) may be off main; the tip of main replaces it.
  const live = await liveReleaseAt(BASE!);
  if (!live) {
    console.log(
      `  \x1b[33m⚠ could not read the live release from ${BASE}/health/version — not compared\x1b[0m`,
    );
  } else if (live.verified && !isAncestor(live.sha, head)) {
    provenanceProblems.push(
      `the site runs ${live.sha}, which is not in HEAD's history — this would take it back`,
    );
  }
  // CI has to have tested exactly this commit (asked only when nothing
  // else is wrong: otherwise --force is needed anyway).
  if (provenanceProblems.length === 0) {
    const problem = ciProblemFor(head, runGh(ROOT));
    if (problem) provenanceProblems.push(problem);
  }

  const FORCED = provenanceProblems.length > 0;
  if (FORCED) {
    const bullets = provenanceProblems.map((p) => `    • ${p}`).join('\n');
    if (!args.has('--force')) {
      console.error('\x1b[31m✖ Refusing to deploy — this artifact is not reproducible:\x1b[0m');
      console.error(bullets);
      console.error('\n  Fix the above, or re-run with --force if you accept shipping');
      console.error('  code that exists only on this machine.');
      process.exit(2);
    }
    console.log('\x1b[33m⚠ --force: shipping an unreproducible artifact:\x1b[0m');
    console.log(bullets);
  }

  const releaseSha =
    runCapture('git rev-parse --short=12 HEAD').trim() + (FORCED ? '-unverified' : '');

  console.log(`Release sha: ${releaseSha}`);
  console.log(`Branch: ${gitBranch}`);
  return releaseSha;
}
// A rollback ships nothing from this machine, so provenance is moot.
const releaseSha = ROLLBACK ? '' : await provenanceGates();
/** The build the smoke must find live (a rollback learns it after the restore). */
let expectedSha = DRY ? '' : releaseSha;
/** The server's time just before step 4c restarted the api. */
let restartedAt = '';

/**
 * Pre-flight: never swap the frontend out from under a purchaser who is
 * standing in the market (2026-07-26).
 *
 * The web swap in step 4b bumps web/dist/build-id.txt, so every live
 * client sees a version mismatch and gets a reload prompt. A PurchaseRow
 * holds the typed qty/price in LOCAL component state until the ✓ commits
 * it — a reload mid-row silently discards whatever the purchaser has
 * entered but not saved, and they are unlikely to notice which row it
 * was. That is a data-integrity event, not a developer inconvenience.
 *
 * `planned` runs are not blocking: nothing is being typed yet.
 *
 * `amending` IS blocking, and was missing here until 2026-07-27. It is a
 * super-admin reopening a FINISHED run to correct its records, which is
 * the same unsaved-input risk as `purchasing` and touches money that has
 * already been settled. The gap showed up in the only way these things
 * ever do — a deploy that reported "no run in purchasing/delivering" and
 * restarted the api 8 seconds after a RunReopened, with the matching
 * RunRefinalized landing 31 seconds later on the new build. It happened
 * to survive. The check was simply not looking.
 */
if (!DRY && !args.has('--allow-active-run')) {
  step('0. pre-flight: no run is mid-flight');
  try {
    const out = ssh(
      [
        'set -e',
        'cd /home/ubuntu/compass-alpha',
        'DATABASE_URL=$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d= -f2- | sed \'s/^"\\(.*\\)"$/\\1/\')',
        // RLS is fail-closed: as the app role with no org/system context this
        // SELECT returns zero rows, so the gate never fired. Read in the
        // maintenance system context (transaction-local), like docs/RUNBOOK.md.
        `psql "$DATABASE_URL" -qtA -v ON_ERROR_STOP=1 -c "BEGIN" -c "SET LOCAL app.system_context = 'maintenance'" -c "SELECT run_date || ' #' || run_index || ' (' || status || ')' FROM read_model.market_runs_v WHERE status IN ('purchasing','delivering','amending')" -c "COMMIT"`,
      ].join(' && '),
    );
    const active = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (active.length > 0) {
      console.error('\x1b[31m✖ Refusing to deploy — a run is in progress:\x1b[0m');
      for (const a of active) console.error(`    • ${a}`);
      console.error('\n  Restarting the api forces a reload prompt on every live client,');
      console.error('  which discards any price a purchaser has typed but not yet saved.');
      console.error('  Wait for the run to finish, or re-run with --allow-active-run.');
      process.exit(1);
    }
    console.log('  ✓ no run in purchasing/delivering/amending');
  } catch (err) {
    // Review OPS-04 (2026-11): this was a warning, and the deploy went on to
    // restart the api under a purchaser who might be typing prices.
    console.error('\x1b[31m✖ Refusing to deploy — could not check for a run in progress:\x1b[0m');
    console.error('  ' + String((err as Error).message ?? err));
    console.error('  Fix psql on the server, or re-run with --allow-active-run if you know');
    console.error('  no run is being purchased, delivered or amended.');
    process.exit(1);
  }
}

// Review OPS-08 (2026-11): the browser smokes run after the restart, and a
// machine that cannot start their browser used to find out only then. A
// rollback goes ahead without it: the old release back matters more than
// the checks after it.
step('0.4. the browser the smokes use starts here');
{
  const limit = 2 * MINUTE;
  const browser = spawnSync(
    'node',
    ['--experimental-strip-types', join(__dirname, 'check-browser.ts')],
    { stdio: 'inherit', timeout: limit },
  );
  if (browser.status !== 0) {
    const why = `the browser smokes could not run here${stoppedNote(browser, limit)}`;
    const fix = [
      '  Install their browser (npx playwright install chromium), or set',
      '  PLAYWRIGHT_CHANNEL=chrome to use an installed Google Chrome.',
    ];
    if (!ROLLBACK) {
      console.error(`\x1b[31m✖ Refusing to deploy — ${why}.\x1b[0m`);
      for (const line of fix) console.error(line);
      process.exit(1);
    }
    console.log(`  \x1b[33m⚠ rolling back anyway, but ${why}.\x1b[0m`);
    for (const line of fix) console.log(line);
  }
}

// A rollback ships nothing, so there is nothing new to test.
if (!ROLLBACK) {
  step('0.5. unit tests (before anything is shipped)');
  // This ran AFTER the api restart, so a red suite was reported on a release
  // that was already live. PG-backed tests are skipped here (prod PG isn't
  // reachable from the dev box); CI runs them on every push.
  //
  // 2026-10-21: paths are RELATIVE to ROOT (bun 1.1.x treats an absolute
  // directory argument as an entry point and fails with ModuleNotFound) and
  // mirror the CI unit job. apps/api validates its env at import time, so
  // — like CI — fill placeholders when the shell has none: the database URL
  // points at an unreachable local port and SKIP_PG_TESTS keeps every
  // PG-backed test skipped, so nothing here can touch a real database.
  const tt = spawnSync(
    'bun',
    [
      'test',
      'packages/domain',
      'packages/contracts',
      'packages/db',
      'packages/i18n',
      'packages/ui',
      'apps/api',
      'apps/worker',
      'apps/web/src',
      'scripts',
    ],
    {
      stdio: 'inherit',
      cwd: ROOT,
      timeout: LIMIT.step,
      env: {
        ...process.env,
        SKIP_PG_TESTS: '1',
        DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unit:unit@127.0.0.1:1/unit_tests',
        JWT_SECRET: process.env.JWT_SECRET ?? 'deploy-unit-test-access-secret-xxxxxxxxxxxxxx',
        JWT_REFRESH_SECRET:
          process.env.JWT_REFRESH_SECRET ?? 'deploy-unit-test-refresh-secret-xxxxxxxxxxxxx',
      },
    },
  );
  if (tt.status !== 0) {
    console.error(
      `\x1b[31m✖ unit tests FAILED${stoppedNote(tt, LIMIT.step)} — nothing was deployed\x1b[0m`,
    );
    process.exit(1);
  }
}

/**
 * Review OPS-02 (2026-11-09): a deploy runs migrations, and the way back
 * from a bad one is last night's dump. Backups failed silently twice (CRLF
 * in the script; from 2026-08 to 2026-11 the backup role could not read a
 * new table) and nothing looked. A rollback is an emergency and is not
 * held up by this.
 */
if (!DRY && !ROLLBACK) {
  step("0.6. pre-flight: last night's backup");
  try {
    const problem = backupProblem(ssh(backupHealthScript()));
    if (problem && !args.has('--allow-stale-backup')) {
      console.error(`\x1b[31m✖ Refusing to deploy — ${problem}.\x1b[0m`);
      console.error('  A deploy runs migrations; without a recent dump there is no way back');
      console.error('  from a bad one. Look at: journalctl -u compass-backup.service -n 50');
      console.error('  (infra/backup/, docs/RUNBOOK.md). Deploy anyway: --allow-stale-backup.');
      process.exit(1);
    }
    console.log(
      problem
        ? `  \x1b[33m⚠ --allow-stale-backup: ${problem}\x1b[0m`
        : '  ✓ backup timer running, last run ok, newest dump under 26 hours old',
    );
  } catch (err) {
    // Review OPS-04 (2026-11): a check that cannot run is not a pass.
    if (!args.has('--allow-stale-backup')) {
      console.error("\x1b[31m✖ Refusing to deploy — could not check last night's backup:\x1b[0m");
      console.error('  ' + String((err as Error).message ?? err));
      console.error('  Deploy anyway: --allow-stale-backup.');
      process.exit(1);
    }
    console.log(
      `  \x1b[33m⚠ --allow-stale-backup: couldn't check the backups: ${(err as Error).message}\x1b[0m`,
    );
  }
}

/**
 * Read-only checks of the server's own state (its .env files, its database
 * role). Review OPS-01 (2026-11-09): they used to run after the new release
 * was extracted and migrated, so a failed check left the server changed.
 * Nothing they read is part of a release, so they run before the upload.
 */
if (!DRY) {
  step('0.7. verify no dev auth bypass in any server .env (P0-3 defense in depth)');
  // The vite.config.ts + AuthGate.tsx already prevent the mock initData
  // from reaching production code paths, but we belt-and-braces here:
  // refuse to deploy if any server-side .env file (root, apps/web, etc.)
  // carries the dev override. M3.25 (2026-05-18 incident #2) extended
  // this from a single-file grep to cover apps/*/env.
  let bypassFiles: string[];
  try {
    bypassFiles = devBypassFiles(ssh(devBypassScript()));
  } catch (err) {
    // Review OPS-03 (2026-11): the old check passed whenever grep failed.
    console.error("\x1b[31m✖ couldn't check the server .env files — aborting deploy.\x1b[0m");
    console.error('  ' + String((err as Error).message ?? err));
    process.exit(1);
  }
  if (bypassFiles.length > 0) {
    console.error(
      '\x1b[31m✖ Server .env file(s) carry VITE_DEV_MOCK_INIT_DATA — aborting deploy.\x1b[0m',
    );
    console.error('  Offending file(s): ' + bypassFiles.join(', '));
    console.error('  Unset on the server before deploying.');
    process.exit(1);
  }
  console.log('  ✓ no server .env file sets VITE_DEV_MOCK_INIT_DATA');

  step('0.8. verify PG role "compass" does not BYPASSRLS (defense in depth)');
  // RLS policies are useless if the connecting role bypasses them, and a
  // superuser ignores them as completely, FORCE or not. psql is available
  // on the server; reads DATABASE_URL from .env. Review OPS-04 (2026-11): a
  // superuser and a failed psql were warnings, so a deploy went out with
  // RLS not applying. Both now stop it, unless --skip-rls-check.
  let problem: string | null;
  let ran = true;
  try {
    problem = rlsRoleProblem(
      ssh(
        [
          'set -e',
          'cd /home/ubuntu/compass-alpha',
          'DATABASE_URL=$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d= -f2- | sed \'s/^"\\(.*\\)"$/\\1/\')',
          `psql "$DATABASE_URL" -tAc "SELECT rolbypassrls::text || ',' || rolsuper::text FROM pg_roles WHERE rolname = current_user"`,
        ].join(' && '),
      ),
    );
  } catch (err) {
    ran = false;
    problem = `the check did not run (psql failed): ${(err as Error).message}`;
  }
  if (problem && !args.has('--skip-rls-check')) {
    console.error(`\x1b[31m✖ Refusing to deploy — ${problem}.\x1b[0m`);
    if (ran) {
      console.error('  The app must connect as a plain role (NOSUPERUSER NOBYPASSRLS) that does');
      console.error('  not own the tables. On the DB host, as a superuser:');
      console.error('    ALTER ROLE compass NOSUPERUSER NOBYPASSRLS;');
    } else {
      console.error('  Fix psql on the server first.');
    }
    console.error('  Deploy anyway: --skip-rls-check.');
    process.exit(1);
  }
  console.log(
    problem
      ? `  \x1b[33m⚠ --skip-rls-check: ${problem}\x1b[0m`
      : '  ✓ DB role is not a superuser and does not bypass RLS',
  );
}

/** Shell script: install exactly the dependencies the tree on disk locks. */
function installScript(): string {
  // 2026-10-30: pipefail — `| tail -5` used to report tail's exit code, so
  // a failed install went on to restart the api on missing deps.
  return [
    'set -o pipefail',
    'export PATH=$HOME/.bun/bin:$PATH',
    `cd ${APP_DIR}`,
    // Frozen: the server must install exactly what CI tested, not
    // re-resolve and quietly rewrite the lockfile.
    'pnpm install --frozen-lockfile 2>&1 | tail -5',
  ].join(' && ');
}

/** Shell script: the systemd units and helpers from the tree on disk. */
function unitsScript(): string {
  // M3.18 (2026-05-16): compass-api.service now ships in the repo too;
  // earlier it was hand-edited on the server and absent from version
  // control, leaving the unit at risk of drift on a host rebuild.
  return [
    `sudo cp ${APP_DIR}/infra/systemd/compass-api.service /etc/systemd/system/compass-api.service`,
    `sudo cp ${APP_DIR}/infra/systemd/compass-worker.service /etc/systemd/system/compass-worker.service`,
    `sudo cp ${APP_DIR}/infra/systemd/compass-app-tunnel.service /etc/systemd/system/compass-app-tunnel.service`,
    `sudo cp ${APP_DIR}/infra/systemd/compass-origin-watch.service /etc/systemd/system/compass-origin-watch.service`,
    `sudo cp ${APP_DIR}/infra/systemd/compass-origin-watch.timer /etc/systemd/system/compass-origin-watch.timer`,
    `sudo install -m 755 ${APP_DIR}/infra/tunnel/compass-origin-watch.sh /usr/local/bin/compass-origin-watch`,
    'sudo systemctl daemon-reload',
    'sudo systemctl enable compass-api.service compass-worker.service',
    'sudo systemctl enable --now compass-app-tunnel.service compass-origin-watch.timer',
  ].join(' && ');
}

/**
 * Review OPS-01 (2026-11-09): a step between the extract and the restart
 * failed. The disk has the new release while the api and worker still run
 * the old one; a crash or a reboot would have started the new code against
 * the old bundle, a database that was not migrated, or half-installed
 * dependencies. Put the release kept in step 2.5 back, with its own
 * dependencies and units, so the disk matches what runs again. Nothing is
 * restarted. If this fails too, `.deploy-incomplete` stays, and the next
 * deploy keeps the older snapshot instead of this tree.
 */
function abortAfterExtract(what: string, err: unknown): never {
  console.error(`\x1b[31m✖ ${what}\x1b[0m`);
  console.error(String((err as Error)?.message ?? err));
  step('undo. put the previous release back (nothing was restarted)');
  try {
    console.log('  ' + ssh(restoreScript()).trim());
    console.log(ssh(installScript()));
    ssh(unitsScript());
    console.error(
      '\x1b[33m  The previous release is back on disk; the running api and worker never changed.\x1b[0m',
    );
    console.error('  Migrations that already ran stay applied (they only go forward).');
  } catch (undoErr) {
    console.error(
      '\x1b[31m✖ putting the previous release back FAILED — do not restart the api or worker.\x1b[0m',
    );
    console.error('  Run: bun run scripts/deploy.ts --rollback');
    console.error(String((undoErr as Error)?.message ?? undoErr));
  }
  process.exit(1);
}

if (!DRY) {
  if (!ROLLBACK) {
    // Incremental upload (2026-11-06) where both ends have rsync: only
    // the changed files cross the slow link, and the server builds the
    // tarball. Otherwise the whole tarball is uploaded, as before.
    let shipped = false;
    if (canRsync()) {
      step('1-2. rsync changed files to the server, build the tarball there');
      try {
        console.log('  staging copy: ' + ssh(stageSeedScript()).trim());
        rsyncWithRetry();
        console.log('  ' + ssh(stageTarScript()).trim());
        shipped = true;
      } catch (err) {
        console.warn('\x1b[33m⚠ incremental upload failed — uploading the whole tarball\x1b[0m');
        console.warn('  ' + String((err as Error).message ?? err).split('\n')[0]);
      }
    }
    if (!shipped) {
      step('1. Tar local source');
      // Excludes: scripts/lib/deployRemote.ts SHIP_EXCLUDES (node_modules,
      // build output, every .env, .git, .claude, .worktrees, keys).
      run(`tar ${tarExcludes()} -czf "${TARBALL_RELATIVE}" CompassAlpha`, { cwd: PARENT });

      step('2. scp to server');
      run(`scp ${SSH_OPTS} "${TARBALL}" ${HOST}:/home/ubuntu/`, { timeoutMs: LIMIT.scp });
    }

    // N9 (2026-10-30): the API had no way back — only the web bundle kept
    // a dist.prev. Keep the whole live release (code + bundle, not
    // node_modules or the server's .env files) before extracting over it.
    // `--rollback` puts it back. A failed snapshot stops here, before
    // anything on the server has changed.
    step('2.5. keep the live release for --rollback');
    try {
      console.log('  ' + ssh(snapshotScript()).trim());
    } catch (err) {
      console.error('\x1b[31m✖ could not keep the live release — aborting before extract\x1b[0m');
      console.error(String((err as Error).message ?? err));
      process.exit(1);
    }

    step('3. extract on server');
    // OPS-01: from here until the restart, the disk is not what runs.
    ssh(markIncompleteScript(releaseSha));
    try {
      ssh(`tar xzf /home/ubuntu/compass-alpha-deploy.tar.gz -C ${APP_DIR} --strip-components=1`);
    } catch (err) {
      abortAfterExtract('extract FAILED', err);
    }
  } else {
    // N9: put the release kept by the last deploy's step 2.5 back. The
    // remaining steps (deps, units, env checks, restart, smokes) are the
    // deploy's own; migrations and the web build are skipped — the
    // snapshot carries its built bundle, and migrations only go forward.
    step('R1. restore the previous release');
    try {
      console.log('  ' + ssh(describeSnapshotScript()).trim().replace(/\n/g, '\n  '));
      console.log('  ' + ssh(restoreScript()).trim());
    } catch (err) {
      console.error(`\x1b[31m✖ rollback FAILED — ${PREV_TARBALL} missing or unreadable.\x1b[0m`);
      console.error('  Nothing was restarted. If the web bundle was moved aside, the restore');
      console.error('  script moved it back.');
      console.error(String((err as Error).message ?? err));
      process.exit(1);
    }
  }

  step('3.5. pnpm install (sync workspace deps if package.json changed)');
  try {
    console.log(ssh(installScript()));
  } catch (err) {
    if (!ROLLBACK) abortAfterExtract('pnpm install FAILED', err);
    console.error('\x1b[31m✖ pnpm install FAILED — aborting before the api restart\x1b[0m');
    console.error(String((err as Error).message ?? err));
    process.exit(1);
  }

  if (!ROLLBACK) {
    step('3.7. db migrations (idempotent — drizzle skips already-applied)');
    // We previously piped to `tail -20`, which masked migrate failures
    // because the pipeline exit code is tail's (always 0). A real
    // PostgresError shipped silently for several deploys, leaving prod
    // without the display_name_locked column. Now: full output, no pipe,
    // and `ssh()` throws on non-zero so we abort before the api restart.
    try {
      console.log(
        ssh(
          [
            'export PATH=$HOME/.bun/bin:$PATH',
            'cd /home/ubuntu/compass-alpha',
            'pnpm --filter @compass/db migrate 2>&1',
          ].join(' && '),
        ),
      );
    } catch (err) {
      abortAfterExtract('db migrate FAILED', err);
    }
  }

  step('4a. install/refresh systemd units (api, worker, tunnel, watchdog)');
  try {
    ssh(unitsScript());
  } catch (err) {
    if (!ROLLBACK) abortAfterExtract('installing the systemd units FAILED', err);
    console.error('\x1b[31m✖ installing the systemd units FAILED — nothing was restarted\x1b[0m');
    console.error(String((err as Error).message ?? err));
    process.exit(1);
  }

  if (!ROLLBACK) {
    /**
     * 2026-10-21 audit CA-37: the web bundle used to be built AFTER the api
     * restart, and `vite build` empties dist/ before writing it. For the
     * length of the build the new api was serving a dist/ that was missing
     * or half-written — every page load in that window 404'd its assets or
     * fell through to JSON. Now the bundle is built beside the live one and
     * renamed into place (two same-filesystem renames, microseconds apart)
     * BEFORE the restart, so there is no window of new api + missing
     * assets. A failed build aborts here, before anything restarts, and
     * leaves the live dist/ untouched.
     *
     * The previous bundle is kept as dist.prev for exactly one deploy:
     * rolling the frontend back is `mv dist dist.bad && mv dist.prev dist`
     * (see docs/RUNBOOK.md "Roll back a bad deploy").
     */
    step('4b. build web into dist.next, then swap into place');
    try {
      console.log(
        ssh(
          [
            'set -e',
            'set -o pipefail',
            'export PATH=$HOME/.bun/bin:$PATH',
            'cd /home/ubuntu/compass-alpha/apps/web',
            'rm -rf dist.next',
            `VITE_BUILD_SHA=${JSON.stringify(releaseSha)} pnpm exec vite build --outDir dist.next --emptyOutDir 2>&1 | tail -10`,
            'test -f dist.next/index.html',
            'rm -rf dist.prev',
            'if [ -d dist ]; then mv dist dist.prev; fi',
            'mv dist.next dist',
          ].join(' && '),
        ),
      );
    } catch (err) {
      abortAfterExtract('web build FAILED', err);
    }
  }

  step('4c. restart api + worker');
  try {
    // OPS-09: the server's clock just before the restart; the api the
    // smoke reaches must have started after it.
    restartedAt = ssh(
      `date -u +%Y-%m-%dT%H:%M:%SZ && sudo systemctl restart compass-api compass-worker && sleep 2 && sudo systemctl is-active compass-api compass-worker`,
    )
      .split('\n')[0]!
      .trim();
  } catch (err) {
    // The new code is what runs now (or fails to). `.deploy-incomplete`
    // stays, so the next deploy does not keep this tree as its rollback.
    console.error('\x1b[31m✖ api or worker did not come up after the restart\x1b[0m');
    console.error(String((err as Error).message ?? err));
    console.error('  Put the previous release back now: bun run scripts/deploy.ts --rollback');
    process.exit(1);
  }
  // OPS-08: the smokes start once the api answers through the public URL.
  const ready = await waitUntilReady(BASE!);
  if (!ready.ok) {
    console.error(
      `\x1b[31m✖ ${BASE}/health/ready did not answer 200 within 90 s: ${ready.last}\x1b[0m`,
    );
    console.error('  The api and worker were restarted. If the release is at fault, put the');
    console.error('  previous one back: bun run scripts/deploy.ts --rollback. If the api is');
    console.error('  fine on the server, look at the path to it (tunnel, Worker).');
    process.exit(1);
  }
  console.log(`  ✓ ${BASE}/health/ready answered after ${Math.round(ready.afterMs / 1000)} s`);
  // OPS-01: the processes run the release on disk again.
  try {
    ssh(clearIncompleteScript());
  } catch (err) {
    console.log(
      `  \x1b[33m⚠ couldn't clear ${APP_DIR}/.deploy-incomplete: ${(err as Error).message}\x1b[0m`,
    );
  }

  // M1.9 (2026-05-07): is-active above only proves the process is
  // alive — it's still possible for the worker to start, fail to
  // connect to PG, log an error, and sit there with the unit "active"
  // because grammY's failure path doesn't exit. Verify the worker
  // logged its `[worker] online` banner since the restart so we
  // know it actually entered the flush loop.
  step('4d. verify worker startup banner (warn-only)');
  try {
    const journal = ssh(
      `journalctl -u compass-worker --since '60 seconds ago' --no-pager 2>&1 | tail -20`,
    );
    if (journal.includes('[worker] online')) {
      console.log('  ✓ worker logged "online" since restart');
    } else {
      console.log(
        `  \x1b[33m⚠ no "[worker] online" line in last 60s — worker may have failed to connect (DB? bot token?). Tail:\x1b[0m\n${journal}`,
      );
    }
  } catch (err) {
    console.log(`  \x1b[33m⚠ couldn't read worker journal: ${(err as Error).message}\x1b[0m`);
  }

  step('verify deployed assets');
  const newHash = ssh(
    `ls /home/ubuntu/compass-alpha/apps/web/dist/assets/index-*.js | head -1`,
  ).trim();
  console.log(`  bundle: ${newHash}`);
  try {
    const buildId = ssh(`cat /home/ubuntu/compass-alpha/apps/web/dist/build-id.txt`).trim();
    console.log(`  build-id: ${buildId}`);
    // A rollback brings back whichever release the snapshot holds.
    if (ROLLBACK) expectedSha = buildId;
  } catch {
    console.log(`  \x1b[33mbuild-id.txt missing — buildShaPlugin may not have run\x1b[0m`);
  }
}

// The smoke's realtime check needs the token-less probe (N1, 2026-10-30).
// A rollback to a release from before it cannot answer the probe; say
// so instead of failing the rollback on it. Checked on main.ts because
// extraction never deletes: the newer socket.ts stays on disk, unused.
let smokeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  // OPS-09: the smoke checks that the public URL serves this release, from
  // an api started after the restart. It used to accept any commit, so a
  // Worker pointing at another backend passed.
  ...(expectedSha ? { COMPASS_EXPECT_SHA: expectedSha } : {}),
  ...(restartedAt ? { COMPASS_EXPECT_STARTED_AFTER: restartedAt } : {}),
};
if (ROLLBACK && !DRY) {
  const probeAware = ssh(
    `grep -q "realtime/socket" ${APP_DIR}/apps/api/src/main.ts && echo yes || echo no`,
  ).trim();
  if (probeAware !== 'yes') {
    console.log(
      '  \x1b[33m⚠ restored api predates the realtime probe — smoke cannot verify the WebSocket upgrade\x1b[0m',
    );
    smokeEnv = { ...smokeEnv, COMPASS_SMOKE_PRE_PROBE_API: '1' };
  }
}

step('6. server-side smoke');
const sm = spawnSync('bun', ['run', join(__dirname, 'smoke.ts')], {
  stdio: 'inherit',
  env: smokeEnv,
  timeout: LIMIT.smoke,
});
if (sm.status !== 0) {
  console.error(`\x1b[31m✖ server-side smoke FAILED${stoppedNote(sm, LIMIT.smoke)}\x1b[0m`);
  process.exit(1);
}

step('7. browser smoke (shallow: render check)');
const bsm = spawnSync('node', ['--experimental-strip-types', join(__dirname, 'browser-smoke.ts')], {
  stdio: 'inherit',
  timeout: LIMIT.smoke,
});
if (bsm.status !== 0) {
  console.error(`\x1b[31m✖ browser smoke FAILED${stoppedNote(bsm, LIMIT.smoke)}\x1b[0m`);
  process.exit(1);
}

step('8. browser smoke (deep: clicks, qty, submit, navigate)');
const bsd = spawnSync(
  'node',
  ['--experimental-strip-types', join(__dirname, 'browser-smoke-deep.ts')],
  { stdio: 'inherit', timeout: LIMIT.smoke },
);
if (bsd.status !== 0) {
  console.error(`\x1b[31m✖ deep browser smoke FAILED${stoppedNote(bsd, LIMIT.smoke)}\x1b[0m`);
  process.exit(1);
}

console.log(
  ROLLBACK
    ? '\n\x1b[32m✔ ROLLBACK GREEN\x1b[0m  The previous release is live and the smokes passed.'
    : '\n\x1b[32m✔ DEPLOY GREEN\x1b[0m  Both smokes passed against the live URL.',
);
