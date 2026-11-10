/**
 * Review OPS-13 (2026-11): a release is what git sees in the checkout,
 * never an ignored file, an .env or a key, with LF line endings; and the
 * incremental upload ends in the same tarball as a full one.
 *
 * Each test builds a scratch git repository, under a name other than
 * CompassAlpha, that converts line endings on checkout as the Windows
 * deploy box does (core.autocrlf=true).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stageSeedScript, stageTarScript } from '../lib/deployRemote';
import { RSYNC_FLAGS, releaseTree, unpackRelease, writeRelease } from '../lib/release';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bash(script: string) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}
function put(base: string, rel: string, body: string) {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), body);
}
function read(base: string, rel: string) {
  return readFileSync(join(base, rel), 'utf8');
}
function git(repo: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout;
}
/** The files in a tarball, sorted. */
function listing(tarball: string) {
  const out = bash(`tar tzf "${tarball}" | grep -v '/$' | LC_ALL=C sort`);
  expect(out.status).toBe(0);
  return out.stdout.trim().split('\n');
}
/** The release of `repo` as it is now, written to `out`. */
function release(repo: string, out: string) {
  writeRelease(repo, releaseTree(repo), out);
  return out;
}

/** A committed checkout, with an .env someone force-added. */
function checkout() {
  const base = mkdtempSync(join(tmpdir(), 'release-'));
  dirs.push(base);
  const repo = join(base, 'a-checkout-of-any-name');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'core.autocrlf', 'true');
  put(repo, '.gitignore', 'node_modules/\ndist/\n.turbo/\n.env\n*.log\n*.key\n');
  put(repo, 'package.json', '{}\n');
  put(repo, 'apps/api/src/main.ts', 'main v1\n');
  put(repo, 'apps/web/src/a.ts', 'a\n');
  put(repo, 'infra/backup/run.sh', '#!/usr/bin/env bash\necho ok\n');
  put(repo, 'apps/api/.env', 'SECRET=1\n');
  git(repo, 'add', '.');
  git(repo, 'add', '-f', 'apps/api/.env');
  git(repo, 'commit', '-qm', 'first');
  return { base, repo };
}

describe('the release (OPS-13)', () => {
  test('what git sees: local changes and new files; nothing ignored, no .env, no key', () => {
    const { base, repo } = checkout();
    put(repo, 'apps/api/src/main.ts', 'main v2\n');
    put(repo, 'apps/api/src/new.ts', 'new\n');
    rmSync(join(repo, 'apps/web/src/a.ts'));
    // On disk, never shipped.
    put(repo, 'node_modules/y/index.js', 'dep');
    put(repo, 'tests/e2e/node_modules/z/index.js', 'dep');
    put(repo, 'apps/web/dist/index.html', 'built');
    put(repo, 'packages/db/.turbo/cache', 'cache');
    put(repo, 'deploy.log', 'log');
    put(repo, 'infra/server.key', 'KEY');
    put(repo, 'infra/deploy.pem', 'KEY');
    put(repo, 'apps/web/.env.production', 'VITE_X=1');
    put(repo, '.claude/worktrees/w/.env', 'BOT=1');
    put(repo, '.claude/worktrees/w/src.ts', 'a whole other checkout');
    const before = [git(repo, 'status', '--porcelain'), git(repo, 'rev-parse', 'HEAD')];

    const tarball = release(repo, join(base, 'release.tar.gz'));

    expect(listing(tarball)).toEqual([
      'CompassAlpha/.gitignore',
      'CompassAlpha/apps/api/src/main.ts',
      'CompassAlpha/apps/api/src/new.ts',
      'CompassAlpha/infra/backup/run.sh',
      'CompassAlpha/package.json',
    ]);
    const unpacked = unpackRelease(tarball, base);
    expect(read(unpacked, 'apps/api/src/main.ts')).toBe('main v2\n');
    // LF, though this checkout writes CRLF (core.autocrlf=true).
    expect(read(unpacked, 'infra/backup/run.sh')).toBe('#!/usr/bin/env bash\necho ok\n');
    // The index, HEAD and the files are as they were.
    expect([git(repo, 'status', '--porcelain'), git(repo, 'rev-parse', 'HEAD')]).toEqual(before);
  });

  test('a clean checkout ships exactly its HEAD', () => {
    const { repo } = checkout();
    expect(releaseTree(repo)).toBe(git(repo, 'rev-parse', 'HEAD^{tree}').trim());
  });

  test.skipIf(spawnSync('rsync', ['--version']).status !== 0)(
    'the staged tarball equals a full one; deletions and changes carry over',
    () => {
      const { base, repo } = checkout();
      const server = join(base, 'server');
      mkdirSync(server);
      const stage = join(server, 'src');
      // The last full upload is still on the server: the stage is seeded from it.
      const tarball = release(repo, join(server, 'deploy.tar.gz'));
      const seeded = bash(stageSeedScript(stage, tarball));
      expect([seeded.status, seeded.stdout.trim()]).toEqual([0, 'seeded']);
      expect(bash(stageSeedScript(stage, tarball)).stdout.trim()).toBe('ready');

      // A change, a new file and a deleted file. The deploy unpacks the
      // release and sends it with rsync; the server builds the tarball.
      put(repo, 'apps/api/src/main.ts', 'main v2\n');
      put(repo, 'apps/api/src/new.ts', 'new\n');
      rmSync(join(repo, 'apps/web/src/a.ts'));
      const full = release(repo, join(base, 'full.tar.gz'));
      const unpacked = join(base, 'unpacked');
      mkdirSync(unpacked);
      const sent = unpackRelease(full, unpacked);
      expect(bash(`rsync ${RSYNC_FLAGS} "${sent}/" "${stage}/CompassAlpha/"`).status).toBe(0);
      expect(bash(stageTarScript(stage, tarball)).status).toBe(0);

      expect(listing(tarball)).toEqual(listing(full));
      expect(listing(tarball)).toEqual([
        'CompassAlpha/.gitignore',
        'CompassAlpha/apps/api/src/main.ts',
        'CompassAlpha/apps/api/src/new.ts',
        'CompassAlpha/infra/backup/run.sh',
        'CompassAlpha/package.json',
      ]);
      const out = join(base, 'out');
      mkdirSync(out);
      expect(read(unpackRelease(tarball, out), 'apps/api/src/main.ts')).toBe('main v2\n');
    },
  );
});
