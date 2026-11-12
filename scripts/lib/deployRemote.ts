/**
 * The pieces of scripts/deploy.ts that decide WHAT runs on the server,
 * kept free of side effects so they can be tested without a server
 * (scripts/__tests__/deployRemote.test.ts runs the snapshot and restore
 * scripts against a scratch directory).
 *
 * N9 (2026-10-30): host key verification and an API rollback path.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Live tree on the server. */
export const APP_DIR = '/home/ubuntu/compass-alpha';
/** The release that was live before the last deploy (code + web bundle). */
export const PREV_TARBALL = '/home/ubuntu/compass-alpha.prev.tar.gz';

/**
 * Shell lines that read DATABASE_URL from `${appDir}/.env` and split it
 * with infra/backup/pg-url.sh: PG_URL_NOPASS for psql's command line, the
 * password in PGPASSWORD (review OPS-32). `psql "$DATABASE_URL"` put the
 * password where every local account can read it, in `ps` (the backup
 * scripts stopped doing that in security scan F11). The helpers' text is
 * sent along, so this runs on a server whose live release predates them.
 */
export function databaseUrlLines(appDir = APP_DIR, root = REPO_ROOT): string[] {
  return [
    readFileSync(join(root, 'infra/lib/env.sh'), 'utf8'),
    readFileSync(join(root, 'infra/backup/pg-url.sh'), 'utf8'),
    `pg_url_split "$(env_get DATABASE_URL "${appDir}/.env")"`,
    'test -n "$PG_URL_NOPASS" || { echo "no DATABASE_URL in the server .env" >&2; exit 3; }',
  ];
}

/**
 * Host keys of the production server, pinned in the repo. Obtained with
 * `ssh-keyscan` on 2026-10-30 and checked against the keys already in the
 * deploying Mac's ~/.ssh/known_hosts (identical). The host names are
 * hashed (`ssh-keygen -H`, 2026-11-10) so this public repo does not name
 * the server; ssh and `ssh-keygen -F <host>` still find them.
 */
export function knownHostsFile(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPASS_DEPLOY_KNOWN_HOSTS ?? join(root, 'infra', 'deploy', 'known_hosts');
}

/** `ubuntu@1.2.3.4` → `1.2.3.4` (the name ssh looks up in known_hosts). */
export function hostName(target: string): string {
  return target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target;
}

/**
 * Options for every ssh/scp call. The deploy used to pass
 * `StrictHostKeyChecking=no`, so whoever answered on that address got the
 * deploy key's session, the production .env and sudo. Now the server must
 * present a key pinned in `knownHosts`, and nothing is ever added to it.
 *
 * Review OPS-07 (2026-11): the link to the server is slow and drops
 * packets, and a connection that died quietly hung the deploy for good.
 * ssh now gives up on a connect after 20 s, and on a session that has not
 * answered for two minutes (8 keepalives 15 s apart).
 */
export function sshOptions(key: string, knownHosts: string): string {
  return [
    `-i "${key}"`,
    '-o StrictHostKeyChecking=yes',
    `-o UserKnownHostsFile="${knownHosts}"`,
    // Don't fall back to ~/.ssh/known_hosts entries for other names.
    '-o GlobalKnownHostsFile=/dev/null',
    '-o BatchMode=yes',
    '-o ConnectTimeout=20',
    '-o ServerAliveInterval=15',
    '-o ServerAliveCountMax=8',
  ].join(' ');
}

/** Review OPS-07 (2026-11): held by every remote step, so they run one at a time. */
export const REMOTE_LOCK = '/home/ubuntu/.compass-deploy.lock';

/**
 * How long the server lets a step run when the deploy waits `limitMs` for
 * it: 90 s less, so the server has ended it (or, 30 s later, killed it)
 * before the deploy gives up.
 */
export function serverLimitSecs(limitMs: number): number {
  return Math.max(1, Math.floor(limitMs / 1000) - 90);
}

/**
 * What ssh runs on the server for one step: `script`, base64'd (see ssh()
 * in deploy.ts), in bash.
 *
 * Review OPS-07 (2026-11): when the deploy gives up on a step (its time
 * limit, a lost connection), the step can still be running on the server,
 * and the undo that follows would work beside it. So the server ends a
 * step after `secs` with everything it started (`timeout` signals its
 * whole process group, and kills 30 s later), and every step holds
 * REMOTE_LOCK: the undo waits for a step that still runs.
 */
export function remoteCommand(script: string, secs: number, lock = REMOTE_LOCK): string {
  const payload = Buffer.from(script, 'utf8').toString('base64');
  return `echo ${payload} | base64 -d | timeout -k 30 ${secs} flock ${lock} bash`;
}

/**
 * A failed step, said in words. execSync's own message is the command
 * line, a base64 payload nobody can read, followed by all of stderr, which
 * it has already shown. Now: how the step ended, and its last line on
 * stderr. An error with no exit status (killed here at its limit) is
 * returned as it is.
 */
export function remoteStepError(err: unknown, secs: number): unknown {
  const { status, stderr } = err as { status?: number | null; stderr?: string };
  if (typeof status !== 'number') return err;
  if (status === 124) {
    return new Error(`the server stopped this step after ${Math.round(secs / 6) / 10} min`);
  }
  const how = status === 255 ? 'ssh failed (exit 255)' : `exit ${status} on the server`;
  const last = (stderr ?? '').trim().split('\n').pop()?.trim();
  return new Error(last ? `${how}: ${last}` : how);
}

/**
 * The top directory of a release tarball (scripts/lib/release.ts). The
 * extract strips it; the rsync stage keeps the release under it.
 */
export const RELEASE_TOP = 'CompassAlpha';

/**
 * Incremental upload (2026-11-06): the link to the server crosses a
 * border with ~300 ms and lossy packets, and the 13 MB tarball took
 * 20+ minutes. The server keeps a copy of the last shipped source in
 * STAGE_DIR/RELEASE_TOP; rsync sends only what changed, and the server
 * makes the same tarball from it that a full upload would have carried.
 * The rest of the deploy is unchanged.
 */
export const STAGE_DIR = '/home/ubuntu/compass-alpha-src';
export const DEPLOY_TARBALL = '/home/ubuntu/compass-alpha-deploy.tar.gz';

/**
 * Shell script: make sure the staging copy exists. The first time it is
 * seeded from the last uploaded tarball (still on the server), so even
 * the first incremental upload sends only the difference. Prints
 * "seeded", "ready" or "empty".
 */
export function stageSeedScript(stageDir = STAGE_DIR, tarball = DEPLOY_TARBALL): string {
  return [
    'set -e',
    'command -v rsync >/dev/null',
    `if [ -d "${stageDir}/${RELEASE_TOP}" ]; then echo ready; exit 0; fi`,
    `mkdir -p "${stageDir}.tmp"`,
    `if [ -f "${tarball}" ] && tar xzf "${tarball}" -C "${stageDir}.tmp"; then`,
    `  rm -rf "${stageDir}"; mv "${stageDir}.tmp" "${stageDir}"; echo seeded`,
    'else',
    `  rm -rf "${stageDir}.tmp"; mkdir -p "${stageDir}/${RELEASE_TOP}"; echo empty`,
    'fi',
  ].join('\n');
}

/** Shell script: the deploy tarball from the staging copy (temp name, then rename). */
export function stageTarScript(stageDir = STAGE_DIR, tarball = DEPLOY_TARBALL): string {
  return [
    'set -e',
    `tar -czf "${tarball}.tmp" -C "${stageDir}" ${RELEASE_TOP}`,
    `mv -f "${tarball}.tmp" "${tarball}"`,
    `echo "built ${tarball} ($(du -h "${tarball}" | cut -f1))"`,
  ].join('\n');
}

/**
 * Review OPS-01 (2026-11-09): written into the live tree just before a
 * deploy extracts over it, removed once the api and worker run the release
 * on disk (or once the previous release is put back). While it is there,
 * the tree is something that never ran: new code beside the old bundle, a
 * database maybe not migrated, dependencies maybe half installed. The next
 * deploy must not keep that as its rollback point.
 */
export const INCOMPLETE_MARKER = '.deploy-incomplete';

/** Shell script: mark the live tree as mid-deploy (release and UTC time). */
export function markIncompleteScript(release: string, appDir = APP_DIR): string {
  return [
    'set -e',
    `cd "${appDir}"`,
    `printf '%s %s\\n' ${JSON.stringify(release)} "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${INCOMPLETE_MARKER}`,
  ].join('\n');
}

/** Shell script: the live tree is a release that runs again. */
export function clearIncompleteScript(appDir = APP_DIR): string {
  return ['set -e', `rm -f "${appDir}/${INCOMPLETE_MARKER}"`].join('\n');
}

/**
 * Review OPS-01: the files the release on disk shipped, one path per line,
 * relative to the app folder. Extracting over the live tree never deleted
 * anything, so a file a release dropped stayed on disk: a renamed
 * migration then fails the migration check at every later deploy, and a
 * removed package failed the frozen install (2026-11-12). The extract and
 * the restore compare this list with the next one and remove what is gone.
 * The server's own files (.env, node_modules, the built bundle) are never
 * part of a release, so never on it.
 */
export const RELEASE_FILES = '.release-files';

/**
 * Exclusions for the rollback snapshot: dependencies (reinstalled from the
 * snapshot's own lockfile), the web bundle's own spare copies, and the
 * server's .env files, which belong to the server and are never part of a
 * release (deploy.ts excludes them from the tarball for the same reason).
 */
const SNAPSHOT_EXCLUDES = [
  'node_modules',
  'dist.prev',
  'dist.next',
  'dist.bad',
  '.env',
  '.env.*',
  '*.log',
  // Working copies of the release list; the list itself is kept.
  `${RELEASE_FILES}.*`,
];

/**
 * Shell script: keep the live release as `prevTarball`, before a deploy
 * extracts anything over it. Written to a temp name and renamed, so a
 * failed or interrupted snapshot never replaces a good one. A live tree
 * without a built web bundle is not a release worth rolling back to; that
 * fails the snapshot (and so the deploy, before anything changed).
 */
export function snapshotScript(appDir = APP_DIR, prevTarball = PREV_TARBALL): string {
  const ex = SNAPSHOT_EXCLUDES.map((p) => `--exclude='${p}'`).join(' ');
  return [
    'set -e',
    `cd "${appDir}"`,
    // OPS-01: the last deploy stopped after extracting and nothing put the
    // old release back. Keep the snapshot from before that deploy.
    `if [ -f ${INCOMPLETE_MARKER} ]; then`,
    `  test -f "${prevTarball}" || { echo "the last deploy did not finish ($(cat ${INCOMPLETE_MARKER})) and there is no earlier snapshot" >&2; exit 4; }`,
    `  echo "the last deploy did not finish ($(cat ${INCOMPLETE_MARKER})): kept the snapshot from before it"`,
    '  exit 0',
    'fi',
    'test -f apps/web/dist/index.html',
    `tar ${ex} -czf "${prevTarball}.tmp" .`,
    `mv -f "${prevTarball}.tmp" "${prevTarball}"`,
    `echo "kept $(cat apps/web/dist/build-id.txt 2>/dev/null || echo unknown-build) as ${prevTarball} ($(du -h "${prevTarball}" | cut -f1))"`,
  ].join('\n');
}

/** Shell script: print the build id inside the snapshot, or fail if there is none. */
export function describeSnapshotScript(prevTarball = PREV_TARBALL): string {
  return [
    'set -e',
    `test -f "${prevTarball}" || { echo "no previous release at ${prevTarball}" >&2; exit 3; }`,
    `tar -xzOf "${prevTarball}" ./apps/web/dist/build-id.txt 2>/dev/null || echo unknown-build`,
    `echo "saved $(date -r "${prevTarball}" '+%Y-%m-%d %H:%M %Z')"`,
  ].join('\n');
}

/**
 * Shell script: put the snapshot back over the live tree. The web bundle
 * is replaced wholesale (the snapshot carries the complete old dist/);
 * everything else is extracted over the tree, the same way a deploy
 * extracts. Then the files only the release being put aside shipped (its
 * RELEASE_FILES list, less what the snapshot holds) are removed. A tree
 * extracted before that list existed has none, and its files stay on
 * disk, unimported; a workspace package of its own is removed before the
 * install all the same (staleWorkspacesScript). Checked first: an
 * unreadable or bundle-less snapshot changes nothing.
 */
export function restoreScript(appDir = APP_DIR, prevTarball = PREV_TARBALL): string {
  return [
    'set -e',
    `test -f "${prevTarball}"`,
    `tar -tzf "${prevTarball}" | grep -qx './apps/web/dist/index.html'`,
    `cd "${appDir}"`,
    // A failure past this point must not leave the api without a bundle.
    "trap 'if [ ! -f apps/web/dist/index.html ] && [ -d apps/web/dist.bad ]; then rm -rf apps/web/dist; mv apps/web/dist.bad apps/web/dist; fi' ERR",
    'rm -rf apps/web/dist.bad',
    'if [ -d apps/web/dist ]; then mv apps/web/dist apps/web/dist.bad; fi',
    // The snapshot brings its own list (or none) back over this one.
    `if [ -f ${RELEASE_FILES} ]; then mv -f ${RELEASE_FILES} ${RELEASE_FILES}.undo; fi`,
    `tar -xzf "${prevTarball}" -C .`,
    'test -f apps/web/dist/index.html',
    'rm -rf apps/web/dist.bad',
    `if [ -f ${RELEASE_FILES}.undo ]; then`,
    ...listedPathsScript(prevTarball, '\\./', `${RELEASE_FILES}.kept`).map((l) => `  ${l}`),
    `  LC_ALL=C sort -u ${RELEASE_FILES}.undo | LC_ALL=C comm -23 - ${RELEASE_FILES}.kept > ${RELEASE_FILES}.gone`,
    ...removePathsScript(`${RELEASE_FILES}.gone`, 'only the release put aside had it').map(
      (l) => `  ${l}`,
    ),
    `  rm -f ${RELEASE_FILES}.undo ${RELEASE_FILES}.kept ${RELEASE_FILES}.gone`,
    'fi',
    // OPS-01: the source tree is the kept release again.
    `rm -f ${INCOMPLETE_MARKER}`,
    `echo "restored $(cat apps/web/dist/build-id.txt 2>/dev/null || echo unknown-build)"`,
  ].join('\n');
}

/**
 * Shell lines: the paths of the files in `tarball` whose names start with
 * `prefix` (a sed pattern), without it, sorted bytewise, into `out`.
 * Folders are left out, and names are listed as they are (GNU tar would
 * escape a non-ASCII one). tar's own listing goes to a file first, so a
 * tar that fails stops the script under `set -e` rather than handing on
 * half a list.
 */
function listedPathsScript(tarball: string, prefix: string, out: string): string[] {
  return [
    `tar --quoting-style=literal -tzf "${tarball}" > ${out}.tar`,
    `sed -n 's|^${prefix}||p' ${out}.tar | sed -e '/\\/$/d' -e '/^$/d' | LC_ALL=C sort -u > ${out}`,
    `rm -f ${out}.tar`,
  ];
}

/**
 * Shell lines: remove each path listed in `list` (relative to the current
 * folder), then each folder that left empty, and say so. Only files and
 * links are removed, and a path that could lead out of the folder is
 * skipped.
 */
function removePathsScript(list: string, why: string): string[] {
  return [
    'while IFS= read -r f; do',
    '  case "$f" in "" | /* | .. | ../* | */.. | */../*) continue ;; esac',
    '  [ -f "$f" ] || [ -L "$f" ] || continue',
    '  rm -f -- "$f"',
    `  echo "removed $f: ${why}"`,
    '  d=$(dirname -- "$f")',
    '  if [ "$d" != . ]; then rmdir -p -- "$d" 2>/dev/null || true; fi',
    `done < ${list}`,
  ];
}

/**
 * Shell script: extract the release over the live tree (step 3), then
 * remove the files the release before it shipped and this one does not,
 * and keep this release's list for the next deploy. The first extract
 * with a tree that has no list removes nothing. The release must list at
 * least one file: an empty list means a broken listing, and nothing is
 * extracted.
 */
export function extractScript(appDir = APP_DIR, tarball = DEPLOY_TARBALL): string {
  return [
    'set -e',
    `cd "${appDir}"`,
    ...listedPathsScript(tarball, `${RELEASE_TOP}/`, `${RELEASE_FILES}.next`),
    `test -s ${RELEASE_FILES}.next`,
    `tar -xzf "${tarball}" -C . --strip-components=1`,
    `if [ -f ${RELEASE_FILES} ]; then`,
    `  LC_ALL=C sort -u ${RELEASE_FILES} | LC_ALL=C comm -23 - ${RELEASE_FILES}.next > ${RELEASE_FILES}.gone`,
    ...removePathsScript(`${RELEASE_FILES}.gone`, 'not in this release').map((l) => `  ${l}`),
    `  rm -f ${RELEASE_FILES}.gone`,
    'fi',
    `mv -f ${RELEASE_FILES}.next ${RELEASE_FILES}`,
  ].join('\n');
}

/**
 * Shell script: the HTTP status the api answers /health/ready with on the
 * server itself, past nginx, the tunnel and the Worker, asked `tries` times
 * `gapSecs` apart: one line each, "000" when nothing answers, "none" when
 * there is no curl. An api that crashes and restarts can answer once in a
 * while, so one 200 says little. PORT and HOST as its unit reads them from
 * the server .env, else the api's defaults. The deploy asks when the public
 * URL does not answer after a restart, to tell a release that does not
 * start from a way to it that is broken (localReadyVerdict).
 */
export function localReadyScript(appDir = APP_DIR, tries = 3, gapSecs = 2): string {
  return [
    `cd "${appDir}"`,
    `port=$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -1 | tr -d "\\"' ")`,
    `host=$(sed -n 's/^HOST=//p' .env 2>/dev/null | tail -1 | tr -d "\\"' ")`,
    'case "$host" in "" | 0.0.0.0 | "::") host=127.0.0.1 ;; esac',
    `for i in $(seq 1 ${tries}); do`,
    `  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$host:\${port:-3000}/health/ready" 2>/dev/null || true)`,
    '  echo "${code:-none}"',
    `  if [ "$i" -lt ${tries} ]; then sleep ${gapSecs}; fi`,
    'done',
  ].join('\n');
}

/**
 * What localReadyScript's answers say: `up` when every try answered 200
 * (the way to the api is at fault), `down` when they all came back and
 * one did not (the release is at fault), `unknown` when the script did not
 * say (no curl, a broken connection).
 */
export function localReadyVerdict(output: string, tries = 3): 'up' | 'down' | 'unknown' {
  const codes = output.trim().split(/\s+/).filter(Boolean);
  if (codes.length !== tries || !codes.every((c) => /^\d{3}$/.test(c))) return 'unknown';
  return codes.every((c) => c === '200') ? 'up' : 'down';
}

/** pnpm-workspace.yaml's `packages` globs; a test keeps the two the same. */
export const WORKSPACE_GLOBS = ['apps/*', 'packages/*', 'tests/*'] as const;

/**
 * Shell script: remove the workspace packages the release on disk does not
 * have, before its dependencies are installed (2026-11-12). A deploy, and
 * a rollback, extracts over the live tree, so a package only the previous
 * release had stays behind. pnpm finds it through the workspace globs, and
 * `install --frozen-lockfile` then refuses a lockfile that does not list
 * it: the deploy after a revert stopped on packages/streams that way, and
 * so did putting the previous release back.
 *
 * A package is the release's when its pnpm-lock.yaml has an importer for
 * it. Without a lockfile that lists importers nothing is removed.
 */
export function staleWorkspacesScript(appDir = APP_DIR): string {
  return [
    '(',
    'set -e',
    `cd "${appDir}"`,
    "grep -q '^importers:' pnpm-lock.yaml 2>/dev/null || exit 0",
    `for dir in ${WORKSPACE_GLOBS.join(' ')}; do`,
    '  [ -f "$dir/package.json" ] || continue',
    '  grep -qxF "  $dir:" pnpm-lock.yaml && continue',
    '  rm -rf -- "$dir"',
    '  echo "removed $dir: not a workspace package of this release"',
    'done',
    ')',
  ].join('\n');
}

/**
 * Review OPS-03 (2026-11): shell script for step 0.7, which refuses a
 * server .env that sets the dev login bypass. The grep used to end in
 * `|| echo __CLEAN__`. The glob for the packages' .env files matches
 * nothing on the server, so grep exited 2 (a file it could not open) even
 * when it had found the bypass. The output then carried the file name and
 * __CLEAN__, and the check passed. Now only files that exist are searched,
 * and grep's exit code decides: the files and `bypass`, or `clean`, or
 * exit 2 when grep could not read them.
 */
export function devBypassScript(appDir = APP_DIR): string {
  return [
    'shopt -s nullglob',
    'files=()',
    `for f in "${appDir}/.env" "${appDir}"/apps/*/.env "${appDir}"/packages/*/.env; do`,
    '  if [ -f "$f" ]; then files+=("$f"); fi',
    'done',
    'if [ ${#files[@]} -eq 0 ]; then echo clean; exit 0; fi',
    `grep -lE '^VITE_DEV_MOCK_INIT_DATA=.+' "\${files[@]}"`,
    'rc=$?',
    'if [ $rc -eq 0 ]; then echo bypass; exit 0; fi',
    'if [ $rc -eq 1 ]; then echo clean; exit 0; fi',
    'echo "grep exited $rc" >&2',
    'exit 2',
  ].join('\n');
}

/**
 * The .env files that set the bypass, from `devBypassScript`'s output
 * (none when it says `clean`). Anything else throws: a check that did not
 * run must not read as a pass.
 */
export function devBypassFiles(output: string): string[] {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const verdict = lines.pop();
  if (verdict === 'clean' && lines.length === 0) return [];
  if (verdict === 'bypass' && lines.length > 0) return lines;
  throw new Error(`unexpected output from the .env check: ${output.trim() || '(none)'}`);
}

/**
 * Review OPS-22 (2026-11-11): shell script for step 0.75. It prints the
 * NODE_ENV and COMPASS_RELEASE_CHANNEL lines of the server's .env (those
 * two keys and nothing else), then `env-read`; `no-env` when there is no
 * .env; exit 2 when grep could not read it.
 */
export function productionEnvScript(appDir = APP_DIR): string {
  return [
    `f="${appDir}/.env"`,
    'if [ ! -f "$f" ]; then echo no-env; exit 0; fi',
    `grep -E '^[[:space:]]*(NODE_ENV|COMPASS_RELEASE_CHANNEL)[[:space:]]*=' "$f"`,
    'rc=$?',
    'if [ $rc -gt 1 ]; then echo "grep exited $rc" >&2; exit 2; fi',
    'echo env-read',
  ].join('\n');
}

/** The keys `productionEnvProblems` reads, and what each must be when set. */
const PRODUCTION_SWITCHES = ['NODE_ENV', 'COMPASS_RELEASE_CHANNEL'] as const;

/**
 * Review OPS-22 (2026-11-11): what is wrong with the production switches in
 * the server's .env, from `productionEnvScript`'s output (none when
 * nothing is).
 *
 * systemd applies EnvironmentFile= over Environment=, so an .env copied
 * from .env.example (NODE_ENV=development, COMPASS_RELEASE_CHANNEL=
 * development) overrode the units' NODE_ENV=production, and the guards
 * that hold only in production (the bulk purge switch, the dev login)
 * took the server for a development box. A key the .env leaves out is
 * fine: the units set NODE_ENV=production. One it sets must say
 * `production`; the last line wins, as in systemd. Output that is no
 * verdict throws: a check that did not run must not read as a pass.
 */
export function productionEnvProblems(output: string): string[] {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const verdict = lines.pop();
  if (verdict === 'no-env' && lines.length === 0) return [];
  if (verdict !== 'env-read') {
    throw new Error(`unexpected output from the .env check: ${output.trim() || '(none)'}`);
  }
  const values = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    if (!(PRODUCTION_SWITCHES as readonly string[]).includes(key)) {
      throw new Error(`unexpected output from the .env check: ${line}`);
    }
    values.set(
      key,
      line
        .slice(eq + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, '$2'),
    );
  }
  return PRODUCTION_SWITCHES.flatMap((key) => {
    const value = values.get(key);
    return value === undefined || value === 'production'
      ? []
      : [`the server .env sets ${key}=${value || '(empty)'}; it must be production or left out`];
  });
}

/**
 * Review OPS-04 (2026-11): what is wrong with the database role, from
 * step 0.8's `rolbypassrls,rolsuper` line, or null when it is neither.
 * RLS does not apply to a role that bypasses it or to a superuser, so
 * both stop the deploy, and so does an answer that is neither.
 */
export function rlsRoleProblem(output: string): string | null {
  const answer = output.trim();
  const [bypassRls, superuser] = answer.split(',');
  if (bypassRls === 'false' && superuser === 'false') return null;
  if (bypassRls === 'true') return 'the database role bypasses row-level security (BYPASSRLS)';
  if (superuser === 'true')
    return 'the database role is a superuser, so row-level security does not apply';
  return `unexpected answer about the database role: ${answer || '(none)'}`;
}

/** The bun the systemd units start (their ExecStart, infra/systemd/). */
export const UNIT_BUN = '/home/ubuntu/.bun/bin/bun';

/**
 * Review COREAPI-27 (2026-11-12): read-only. The release just extracted
 * reads the server's .env with its worker's own rules
 * (apps/worker/src/config.ts), before the migrations and the restart. A
 * setting the worker cannot read stops it at start, and found only after
 * the restart, the deploy could report it but not undo it. Prints the
 * names of the settings that are wrong, never their values, and exits 1
 * when there is one.
 */
export function workerSettingsScript(appDir = APP_DIR, bun = UNIT_BUN): string {
  const check = [
    'import("./src/config.ts")',
    '.then((m) => { m.readWorkerConfig(process.env); console.log("worker settings: ok"); })',
    '.catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); })',
  ].join('');
  return `cd ${appDir}/apps/worker && ${bun} --env-file=${appDir}/.env -e '${check}'`;
}

/**
 * Review OPS-21 (2026-11-10): read-only shell script. The version of the
 * bun the services run, and of the pnpm and node a deploy step finds on the
 * PATH it sets, one `tool=version` line each (`missing` when one does not
 * answer).
 */
export function toolchainScript(): string {
  return [
    'export PATH=$HOME/.bun/bin:$PATH',
    `echo "bun=$(${UNIT_BUN} --version 2>/dev/null || echo missing)"`,
    'echo "pnpm=$(pnpm --version 2>/dev/null || echo missing)"',
    'echo "node=$(node --version 2>/dev/null || echo missing)"',
  ].join('\n');
}

/** The versions the repository pins. */
export interface PinnedToolchain {
  /** `.bun-version`: exact. */
  bun: string;
  /** `packageManager` in package.json: exact. */
  pnpm: string;
  /** `engines.node` in package.json: `>=N[.M[.P]]` or an exact version. */
  node: string;
}

/** The pins, from the contents of `.bun-version` and package.json. */
export function pinnedToolchain(bunVersionFile: string, packageJson: string): PinnedToolchain {
  const pkg = JSON.parse(packageJson) as {
    packageManager?: string;
    engines?: { node?: string };
  };
  const bun = bunVersionFile.trim();
  if (!/^\d+\.\d+\.\d+$/.test(bun)) {
    throw new Error(`.bun-version is not a version: ${bun || '(empty)'}`);
  }
  const pnpm = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(pkg.packageManager ?? '')?.[1];
  if (!pnpm) throw new Error(`packageManager does not pin pnpm: ${pkg.packageManager ?? '(none)'}`);
  const node = pkg.engines?.node?.trim();
  if (!node) throw new Error('package.json has no engines.node');
  return { bun, pnpm, node };
}

/** `v26.13.0` / `26.13.0` → [26, 13, 0]; null when it is not a version. */
function versionParts(v: string): [number, number, number] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/**
 * Whether `version` meets `range` (`>=N[.M[.P]]` or an exact version);
 * null when the range is neither.
 */
export function meetsVersionRange(version: string, range: string): boolean | null {
  const min = /^>=\s*(.+)$/.exec(range.trim());
  const want = versionParts(min ? min[1]! : range);
  if (!want || (!min && !/^v?\d+\.\d+\.\d+$/.test(range.trim()))) return null;
  const have = versionParts(version);
  if (!have) return false;
  const cmp = have[0] - want[0] || have[1] - want[1] || have[2] - want[2];
  return min ? cmp >= 0 : cmp === 0;
}

/**
 * How the server differs from the pins, from `toolchainScript`'s output:
 * one line per tool, none when all match. A tool that did not answer is a
 * difference. "Production, CI and dev run the same versions" (CLAUDE.md)
 * was kept by hand; the server once ran bun 1.3.13 while the repository
 * said 1.1.38.
 */
export function toolchainProblems(output: string, pinned: PinnedToolchain): string[] {
  const kv = new Map<string, string>();
  for (const line of output.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const said = (tool: string) => kv.get(tool) || 'no answer';
  const problems: string[] = [];
  if (kv.get('bun') !== pinned.bun) {
    problems.push(
      `the services' bun (${UNIT_BUN}) is ${said('bun')}; .bun-version pins ${pinned.bun}`,
    );
  }
  if (kv.get('pnpm') !== pinned.pnpm) {
    problems.push(`the deploy's pnpm is ${said('pnpm')}; packageManager pins ${pinned.pnpm}`);
  }
  const nodeOk = meetsVersionRange(kv.get('node') ?? '', pinned.node);
  if (nodeOk === null) {
    problems.push(
      `engines.node "${pinned.node}" is not >=N or an exact version, so it cannot be checked`,
    );
  } else if (!nodeOk) {
    problems.push(`the deploy's node is ${said('node')}; engines.node wants ${pinned.node}`);
  }
  return problems;
}

/** Where compass-backup.sh writes the nightly dumps (BACKUP_DIR there). */
export const BACKUP_DIR = '/home/ubuntu/compass-backups';

/** A nightly timer plus two hours of slack. */
export const BACKUP_MAX_AGE_SECONDS = 26 * 3600;

/**
 * Review OPS-02 (2026-11-09): read-only shell script. Prints the backup
 * timer's state, whether the last backup run failed, the newest dump and
 * its age in seconds (-1 when there is none), one `key=value` per line.
 */
export function backupHealthScript(dir = BACKUP_DIR): string {
  return [
    'timer=$(systemctl is-active compass-backup.timer 2>/dev/null || true)',
    'unit=$(systemctl is-failed compass-backup.service 2>/dev/null || true)',
    `latest=$(ls -1t "${dir}"/compass-*.dump 2>/dev/null | head -1 || true)`,
    'age=-1',
    'if [ -n "$latest" ]; then age=$(( $(date +%s) - $(stat -c %Y "$latest") )); fi',
    'echo "timer=$timer"',
    'echo "unit=$unit"',
    'echo "latest=$latest"',
    'echo "age=$age"',
  ].join('\n');
}

/**
 * What is wrong with the backups, from `backupHealthScript`'s output, or
 * null when the timer runs, the last run did not fail and the newest dump
 * is recent. Backups failed silently twice before (CRLF in the script;
 * the backup role missing SELECT on a new table, 2026-08 to 2026-11).
 */
export function backupProblem(
  output: string,
  maxAgeSeconds = BACKUP_MAX_AGE_SECONDS,
): string | null {
  const kv = new Map<string, string>();
  for (const line of output.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const timer = kv.get('timer') ?? '';
  if (timer !== 'active') {
    return `the nightly backup timer is not running (compass-backup.timer: ${timer || 'not installed'})`;
  }
  if (kv.get('unit') === 'failed') return 'the last backup run failed (compass-backup.service)';
  const latest = kv.get('latest') ?? '';
  const age = Number(kv.get('age'));
  if (!latest || !Number.isFinite(age) || age < 0) return 'there is no backup file';
  if (age > maxAgeSeconds) {
    return `the newest backup is ${Math.floor(age / 3600)} hours old (${latest})`;
  }
  return null;
}

/**
 * Review OPS-10 (2026-11): the migrations `migrate.ts --pending` listed, one
 * `pending: <tag>` line each. Other lines (pnpm's own) are not tags.
 */
export function pendingMigrationTags(output: string): string[] {
  return output.split('\n').flatMap((line) => {
    const tag = /^pending: (\S+)$/.exec(line.trim())?.[1];
    return tag ? [tag] : [];
  });
}
