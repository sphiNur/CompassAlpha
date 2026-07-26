/**
 * One-button deploy + verify.
 *
 *   bun run scripts/deploy.ts                     # ship + verify
 *   bun run scripts/deploy.ts --dry               # only verify; don't ship
 *   bun run scripts/deploy.ts --force             # ship an unreproducible tree
 *   bun run scripts/deploy.ts --allow-active-run  # ship during a live run
 *
 * The two override flags exist because this script ships a WORKING
 * DIRECTORY rather than a git ref, and both gates protect against that:
 *
 *   --force            skips the provenance gates (clean tree, on main,
 *                      pushed to origin/main). The release sha is then
 *                      suffixed `-unverified` so /health/version cannot
 *                      claim a provenance the artifact does not have.
 *   --allow-active-run skips the check for a run in purchasing/delivering.
 *                      The api restart forces a reload on every live
 *                      client, which discards prices a purchaser has
 *                      typed but not yet committed.
 *
 * Pipeline:
 *   0. Provenance gates (local) + no-active-run pre-flight (server)
 *   1. Tar local CompassAlpha sources (excl. node_modules / .env / .turbo
 *      / .git / .claude)
 *   2. scp to server
 *   3. extract over /home/ubuntu/compass-alpha (in place; no downtime
 *      until the api restart in step 4)
 *   4. systemctl restart compass-api  (api picks up server-side code)
 *   5. pnpm exec vite build            (web/dist gets new hashed bundle
 *      AND the api will read web/dist/build-id.txt for /health/version
 *      so the running clients see a version mismatch and prompt reload)
 *   6. Run server-side tRPC smoke locally against the public URL
 *   7. Run browser smoke locally against the public URL
 *   8. If either fails, exit non-zero; the deploy is "live" but you know
 *      something's broken.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);                          // .../CompassAlpha
const PARENT = dirname(ROOT);                             // .../gemini

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

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');

function step(label: string) {
  console.log(`\n\x1b[36m▶ ${label}\x1b[0m`);
}
function run(cmd: string, opts?: { cwd?: string; quiet?: boolean }): void {
  if (!opts?.quiet) console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd: opts?.cwd ?? ROOT, stdio: opts?.quiet ? 'pipe' : 'inherit' });
}
function runCapture(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { cwd: opts?.cwd ?? ROOT, encoding: 'utf8' });
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
 */
function ssh(cmd: string): string {
  const payload = Buffer.from(cmd, 'utf8').toString('base64');
  return runCapture(
    `ssh -i "${KEY}" -o StrictHostKeyChecking=no ${HOST} "echo ${payload} | base64 -d | bash"`,
  );
}

if (!existsSync(KEY)) {
  console.error(`SSH key not found at ${KEY}`);
  process.exit(2);
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
 */
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
  // Non-fatal on network failure: we still check against whatever
  // origin/main we already have.
  execSync('git fetch origin main --quiet', { cwd: ROOT, stdio: 'pipe' });
} catch {
  console.log('  \x1b[33m⚠ could not fetch origin/main — checking against the local copy\x1b[0m');
}
try {
  execSync('git merge-base --is-ancestor HEAD origin/main', { cwd: ROOT, stdio: 'pipe' });
} catch {
  provenanceProblems.push('HEAD is not an ancestor of origin/main — push and merge it first');
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

/**
 * Pre-flight: never swap the frontend out from under a purchaser who is
 * standing in the market (2026-07-26).
 *
 * The api restart in step 4b bumps web/dist/build-id.txt, so every live
 * client sees a version mismatch and gets a reload prompt. A PurchaseRow
 * holds the typed qty/price in LOCAL component state until the ✓ commits
 * it — a reload mid-row silently discards whatever the purchaser has
 * entered but not saved, and they are unlikely to notice which row it
 * was. That is a data-integrity event, not a developer inconvenience.
 *
 * `planned` runs are not blocking: nothing is being typed yet.
 */
if (!DRY && !args.has('--allow-active-run')) {
  step('0. pre-flight: no run is mid-flight');
  try {
    const out = ssh(
      [
        'set -e',
        'cd /home/ubuntu/compass-alpha',
        'DATABASE_URL=$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d= -f2- | sed \'s/^"\\(.*\\)"$/\\1/\')',
        `psql "$DATABASE_URL" -tAc "SELECT run_date || ' #' || run_index || ' (' || status || ')' FROM read_model.market_runs_v WHERE status IN ('purchasing','delivering')"`,
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
    console.log('  ✓ no run in purchasing/delivering');
  } catch (err) {
    // Same posture as the BYPASSRLS probe below: a failed check is a
    // warning, not a hard stop — otherwise an unrelated psql problem
    // makes the system undeployable.
    console.log(
      `  \x1b[33m⚠ couldn't check for active runs (psql failed): ${(err as Error).message}\x1b[0m`,
    );
  }
}

if (!DRY) {
  step('1. Tar local source');
  // Use --exclude with leading anchored paths so we don't ship 600 MB of node_modules.
  const excludes = [
    '--exclude=CompassAlpha/node_modules',
    '--exclude=CompassAlpha/apps/*/node_modules',
    '--exclude=CompassAlpha/packages/*/node_modules',
    '--exclude=CompassAlpha/apps/*/dist',
    '--exclude=CompassAlpha/apps/*/.turbo',
    '--exclude=CompassAlpha/.turbo',
    // M3.25 (2026-05-18 incident #2): all .env files MUST stay
    // server-side. The previous version excluded only the monorepo-
    // root .env. apps/web/.env on the dev box carried the Vite
    // VITE_DEV_MOCK_INIT_DATA + VITE_API_URL=http://localhost:3000,
    // and every deploy tar'd it up and overwrote the server's
    // production-safe copy — baking a dev auth bypass + a broken
    // API URL into every prod bundle until manually re-fixed.
    // Server keeps its own .env files; dev box's stay out of the
    // tarball entirely.
    '--exclude=CompassAlpha/.env',
    '--exclude=CompassAlpha/.env.*',
    '--exclude=CompassAlpha/apps/*/.env',
    '--exclude=CompassAlpha/apps/*/.env.*',
    '--exclude=CompassAlpha/packages/*/.env',
    '--exclude=CompassAlpha/packages/*/.env.*',
    '--exclude=CompassAlpha/*.log',
    '--exclude=CompassAlpha/test-results',
    '--exclude=*.pem',
    // 2026-07-26: neither of these was excluded, and both were being
    // scp'd to production on every deploy.
    //   .git     — ~10 MB of history the server never reads, and it
    //              shipped every branch name and commit message.
    //   .claude  — agent worktrees. Measured 222 MB, of which one stale
    //              worktree was 206 MB because it carried its OWN
    //              node_modules: the node_modules excludes above are
    //              anchored at `CompassAlpha/apps/*`, so they never
    //              matched `.claude/worktrees/*/apps/*`. That is an
    //              unrelated branch's full checkout, on the prod box.
    '--exclude=CompassAlpha/.git',
    '--exclude=CompassAlpha/.claude',
  ].join(' ');
  run(`tar ${excludes} -czf "${TARBALL_RELATIVE}" CompassAlpha`, { cwd: PARENT });

  step('2. scp to server');
  run(`scp -i "${KEY}" -o StrictHostKeyChecking=no "${TARBALL}" ${HOST}:/home/ubuntu/`);

  step('3. extract on server');
  ssh(`tar xzf /home/ubuntu/compass-alpha-deploy.tar.gz -C /home/ubuntu/compass-alpha --strip-components=1`);

  step('3.5. pnpm install (sync workspace deps if package.json changed)');
  console.log(
    ssh(
      [
        'export PATH=$HOME/.bun/bin:$PATH',
        'cd /home/ubuntu/compass-alpha',
        'pnpm install 2>&1 | tail -5',
      ].join(' && '),
    ),
  );

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
    console.error('\x1b[31m✖ db migrate FAILED — aborting deploy before api restart\x1b[0m');
    console.error(String((err as Error).message ?? err));
    process.exit(1);
  }

  step('4a. install/refresh systemd units (api + worker, idempotent)');
  // M3.18 (2026-05-16): compass-api.service now ships in the repo too;
  // earlier it was hand-edited on the server and absent from version
  // control, leaving the unit at risk of drift on a host rebuild.
  ssh(
    [
      'sudo cp /home/ubuntu/compass-alpha/infra/systemd/compass-api.service /etc/systemd/system/compass-api.service',
      'sudo cp /home/ubuntu/compass-alpha/infra/systemd/compass-worker.service /etc/systemd/system/compass-worker.service',
      'sudo systemctl daemon-reload',
      'sudo systemctl enable compass-api.service compass-worker.service',
    ].join(' && '),
  );

  step('4a-pre. verify no dev auth bypass in any server .env (P0-3 defense in depth)');
  // The vite.config.ts + AuthGate.tsx already prevent the mock initData
  // from reaching production code paths, but we belt-and-braces here:
  // refuse to deploy if any server-side .env file (root, apps/web, etc.)
  // carries the dev override. M3.25 (2026-05-18 incident #2) extended
  // this from a single-file grep to cover apps/*/env.
  const envBypass = ssh(
    `grep -lE '^VITE_DEV_MOCK_INIT_DATA=.+' \
      /home/ubuntu/compass-alpha/.env \
      /home/ubuntu/compass-alpha/apps/*/.env \
      /home/ubuntu/compass-alpha/packages/*/.env \
      2>/dev/null || echo __CLEAN__`,
  );
  if (!envBypass.includes('__CLEAN__')) {
    console.error(
      '\x1b[31m✖ Server .env file(s) carry VITE_DEV_MOCK_INIT_DATA — aborting deploy.\x1b[0m',
    );
    console.error('  Offending file(s): ' + envBypass.trim().replace(/\n/g, ', '));
    console.error('  Unset on the server before deploying.');
    process.exit(1);
  }

  step('4a-pg. verify PG role "compass" does not BYPASSRLS (defense in depth)');
  // RLS policies are useless if the connecting role bypasses them.
  // psql is available on the server; reads DATABASE_URL from .env.
  try {
    const out = ssh(
      [
        'set -e',
        'cd /home/ubuntu/compass-alpha',
        'DATABASE_URL=$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d= -f2- | sed \'s/^"\\(.*\\)"$/\\1/\')',
        `psql "$DATABASE_URL" -tAc "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user"`,
      ].join(' && '),
    );
    if (out.trim() !== 'f') {
      console.error(
        `\x1b[31m✖ DB role bypasses RLS (got: ${out.trim()}) — RLS is ineffective.\x1b[0m`,
      );
      console.error(
        '  Run on the DB host as a superuser: ALTER ROLE compass NOBYPASSRLS;',
      );
      process.exit(1);
    }
    console.log('  ✓ DB role does not bypass RLS');
  } catch (err) {
    console.log(
      `  \x1b[33m⚠ couldn't verify BYPASSRLS (psql failed): ${(err as Error).message}\x1b[0m`,
    );
  }

  step('4b. restart api + worker');
  ssh(
    `sudo systemctl restart compass-api compass-worker && sleep 2 && sudo systemctl is-active compass-api compass-worker`,
  );

  // M1.9 (2026-05-07): is-active above only proves the process is
  // alive — it's still possible for the worker to start, fail to
  // connect to PG, log an error, and sit there with the unit "active"
  // because grammY's failure path doesn't exit. Verify the worker
  // logged its `[worker] online` banner since the restart so we
  // know it actually entered the flush loop.
  step('4c. verify worker startup banner (warn-only)');
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

  step('5. rebuild web');
  console.log(
    ssh(
      [
        'export PATH=$HOME/.bun/bin:$PATH',
        'cd /home/ubuntu/compass-alpha/apps/web',
        `VITE_BUILD_SHA=${JSON.stringify(releaseSha)} pnpm exec vite build 2>&1 | tail -10`,
      ].join(' && '),
    ),
  );

  step('verify deployed assets');
  const newHash = ssh(`ls /home/ubuntu/compass-alpha/apps/web/dist/assets/index-*.js | head -1`).trim();
  console.log(`  bundle: ${newHash}`);
  try {
    const buildId = ssh(`cat /home/ubuntu/compass-alpha/apps/web/dist/build-id.txt`).trim();
    console.log(`  build-id: ${buildId}`);
  } catch {
    console.log(`  \x1b[33mbuild-id.txt missing — buildShaPlugin may not have run\x1b[0m`);
  }
}

step('5.5. domain + integration + web-lib tests (catches schema drift before deploy)');
// Skip the PG-backed full-lifecycle test in this gate: prod PG isn't
// reachable from the dev box and dev PG may not be running. The
// integration coverage already runs on the server when migrations apply.
const tt = spawnSync(
  'bun',
  [
    'test',
    join(ROOT, 'packages/domain'),
    join(ROOT, 'apps/api'),
    join(ROOT, 'apps/web/src/lib'),
  ],
  { stdio: 'inherit', cwd: ROOT, env: { ...process.env, SKIP_PG_TESTS: '1' } },
);
if (tt.status !== 0) {
  console.error('\x1b[31m✖ unit/integration tests FAILED\x1b[0m');
  process.exit(1);
}

step('6. server-side smoke');
const sm = spawnSync('bun', ['run', join(__dirname, 'smoke.ts')], { stdio: 'inherit' });
if (sm.status !== 0) {
  console.error('\x1b[31m✖ server-side smoke FAILED\x1b[0m');
  process.exit(1);
}

step('7. browser smoke (shallow: render check)');
const bsm = spawnSync('node', ['--experimental-strip-types', join(__dirname, 'browser-smoke.ts')], {
  stdio: 'inherit',
});
if (bsm.status !== 0) {
  console.error('\x1b[31m✖ browser smoke FAILED\x1b[0m');
  process.exit(1);
}

step('8. browser smoke (deep: clicks, qty, submit, navigate)');
const bsd = spawnSync(
  'node',
  ['--experimental-strip-types', join(__dirname, 'browser-smoke-deep.ts')],
  { stdio: 'inherit' },
);
if (bsd.status !== 0) {
  console.error('\x1b[31m✖ deep browser smoke FAILED\x1b[0m');
  process.exit(1);
}

console.log('\n\x1b[32m✔ DEPLOY GREEN\x1b[0m  Both smokes passed against the live URL.');
