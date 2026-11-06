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
    `echo "restored $(cat apps/web/dist/build-id.txt 2>/dev/null || echo unknown-build)"`,
  ].join('\n');
}
