/**
 * Review OPS-13 (2026-11): a release is what git sees.
 *
 * The deploy used to ship the working tree minus a hand-kept exclude
 * list, which drifted from .gitignore: ignored files that happened to be
 * on disk went to the server (tests/e2e/node_modules, .turbo caches,
 * Playwright reports, a smoke screenshot), and so would a *.key or *.crt.
 * It also tarred `<parent>/CompassAlpha`, so a checkout under another
 * name could not ship the tarball at all.
 *
 * Now the release is a git tree: the working tree as `git add --all` sees
 * it (tracked files with their local changes, and new files .gitignore
 * does not hide; never an ignored file), staged in a throwaway index, so
 * the real index, HEAD and the files are left as they were. For a clean
 * tree, which the provenance gates require, that is HEAD's tree.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_TOP } from './deployRemote';

/**
 * Never shipped, even when git would: every .env (M3.25, 2026-05-18: a dev
 * box's once shipped a dev login bypass into production; the server keeps
 * its own), key material, and the checkouts tools keep inside this one
 * (2026-07-26, 2026-10-29: one had its own node_modules and a test bot
 * token). .claude is not in .gitignore.
 */
export const NEVER_SHIP = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.crt',
  '.claude/**',
  '.worktrees/**',
] as const;

/** rsync flags for the upload: by checksum, since every unpacked release has new times; deletions carry over. */
export const RSYNC_FLAGS = '-rlptzc --delete --partial --stats';

/** `git` in `root`, without a shell; its stdout, or an error with its stderr. */
function git(root: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync('git', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/** The release, as a git tree id. */
export function releaseTree(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'compass-release-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(root, ['read-tree', 'HEAD'], env);
    git(root, ['add', '--all'], env);
    return git(root, ['write-tree'], env).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Writes `tree` to `out` as a .tar.gz under RELEASE_TOP/, without
 * NEVER_SHIP. Text files get LF whatever this machine's core.autocrlf:
 * a CRLF shebang once stopped the nightly backups (2026-07-30).
 */
export function writeRelease(root: string, tree: string, out: string): void {
  git(root, [
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.eol=lf',
    'archive',
    '--format=tar.gz',
    `--prefix=${RELEASE_TOP}/`,
    '-o',
    out,
    tree,
    '--',
    '.',
    ...NEVER_SHIP.map((glob) => `:(exclude,glob)${glob}`),
  ]);
}

/** Unpacks a release from writeRelease() into `dir`; returns the directory rsync sends. */
export function unpackRelease(tarball: string, dir: string): string {
  const r = spawnSync('tar', ['-xzf', tarball, '-C', dir], { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`tar: ${r.stderr.trim() || `exit ${r.status}`}`);
  return join(dir, RELEASE_TOP);
}
