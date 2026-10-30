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
