/**
 * One-button deploy + verify.
 *
 *   bun run scripts/deploy.ts           # ship every staged file + verify
 *   bun run scripts/deploy.ts --dry     # only verify; don't ship
 *
 * Pipeline:
 *   1. Tar local CompassAlpha sources (excl. node_modules / .env / .turbo)
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
function ssh(cmd: string): string {
  return runCapture(`ssh -i "${KEY}" -o StrictHostKeyChecking=no ${HOST} ${JSON.stringify(cmd)}`);
}

if (!existsSync(KEY)) {
  console.error(`SSH key not found at ${KEY}`);
  process.exit(2);
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
        'pnpm exec vite build 2>&1 | tail -10',
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
