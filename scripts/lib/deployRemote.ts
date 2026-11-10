/**
 * The pieces of scripts/deploy.ts that decide WHAT runs on the server,
 * kept free of side effects so they can be tested without a server
 * (scripts/__tests__/deployRemote.test.ts runs the snapshot and restore
 * scripts against a scratch directory).
 *
 * N9 (2026-10-30): host key verification and an API rollback path.
 */
import { join } from 'node:path';

/** Live tree on the server. */
export const APP_DIR = '/home/ubuntu/compass-alpha';
/** The release that was live before the last deploy (code + web bundle). */
export const PREV_TARBALL = '/home/ubuntu/compass-alpha.prev.tar.gz';

/**
 * Host keys of the production server, pinned in the repo. Obtained with
 * `ssh-keyscan 129.204.59.183` on 2026-10-30 and checked against the keys
 * already in the deploying Mac's ~/.ssh/known_hosts (identical).
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
 */
export function sshOptions(key: string, knownHosts: string): string {
  return [
    `-i "${key}"`,
    '-o StrictHostKeyChecking=yes',
    `-o UserKnownHostsFile="${knownHosts}"`,
    // Don't fall back to ~/.ssh/known_hosts entries for other names.
    '-o GlobalKnownHostsFile=/dev/null',
    '-o BatchMode=yes',
  ].join(' ');
}

/**
 * What a release never carries, relative to the repo root (one list for
 * the tarball and for rsync, so the two cannot drift). Patterns with a
 * slash or a leading name are anchored at the root; `*.pem` is anywhere.
 *
 * - dependencies and build output: reinstalled / rebuilt on the server;
 * - every .env (M3.25, 2026-05-18 incident #2): the server keeps its own,
 *   and a dev box's once shipped a dev auth bypass into production;
 * - .git (history, branch names), .claude and .worktrees (2026-07-26,
 *   2026-10-29: full checkouts, one with its own node_modules and a test
 *   bot token).
 */
export const SHIP_EXCLUDES = [
  'node_modules',
  'apps/*/node_modules',
  'packages/*/node_modules',
  'apps/*/dist',
  'apps/*/.turbo',
  '.turbo',
  '.env',
  '.env.*',
  'apps/*/.env',
  'apps/*/.env.*',
  'packages/*/.env',
  'packages/*/.env.*',
  '*.log',
  'test-results',
  '.git',
  '.claude',
  '.worktrees',
] as const;
/** Matched at any depth. */
const SHIP_EXCLUDES_ANYWHERE = ['*.pem'] as const;

/** `tar` excludes for a tarball of `<parent>/<top>`. */
export function tarExcludes(top = 'CompassAlpha'): string {
  return [
    ...SHIP_EXCLUDES.map((p) => `--exclude=${top}/${p}`),
    ...SHIP_EXCLUDES_ANYWHERE.map((p) => `--exclude=${p}`),
  ].join(' ');
}

/** `rsync` excludes for the repo root as the transfer root. */
export function rsyncExcludes(): string {
  return [
    ...SHIP_EXCLUDES.map((p) => `--exclude='/${p}'`),
    ...SHIP_EXCLUDES_ANYWHERE.map((p) => `--exclude='${p}'`),
  ].join(' ');
}

/**
 * Incremental upload (2026-11-06): the link to the server crosses a
 * border with ~300 ms and lossy packets, and the 13 MB tarball took
 * 20+ minutes. The server keeps a copy of the last shipped source in
 * STAGE_DIR/CompassAlpha; rsync sends only what changed, and the server
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
    `if [ -d "${stageDir}/CompassAlpha" ]; then echo ready; exit 0; fi`,
    `mkdir -p "${stageDir}.tmp"`,
    `if [ -f "${tarball}" ] && tar xzf "${tarball}" -C "${stageDir}.tmp"; then`,
    `  rm -rf "${stageDir}"; mv "${stageDir}.tmp" "${stageDir}"; echo seeded`,
    'else',
    `  rm -rf "${stageDir}.tmp"; mkdir -p "${stageDir}/CompassAlpha"; echo empty`,
    'fi',
  ].join('\n');
}

/** Shell script: the deploy tarball from the staging copy (temp name, then rename). */
export function stageTarScript(stageDir = STAGE_DIR, tarball = DEPLOY_TARBALL): string {
  return [
    'set -e',
    `tar -czf "${tarball}.tmp" -C "${stageDir}" CompassAlpha`,
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
 * extracts — files only the bad release had stay on disk, unimported.
 * Checked first: an unreadable or bundle-less snapshot changes nothing.
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
    `tar -xzf "${prevTarball}" -C .`,
    'test -f apps/web/dist/index.html',
    'rm -rf apps/web/dist.bad',
    // OPS-01: the source tree is the kept release again.
    `rm -f ${INCOMPLETE_MARKER}`,
    `echo "restored $(cat apps/web/dist/build-id.txt 2>/dev/null || echo unknown-build)"`,
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
