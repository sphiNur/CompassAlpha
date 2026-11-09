/**
 * N9 (2026-10-30): the deploy keeps the live release before extracting
 * over it and can put it back (`deploy.ts --rollback`), and ssh/scp check
 * the server's host key against the key pinned in the repo.
 *
 * The snapshot / restore scripts are run for real with bash and the local
 * tar against a scratch tree laid out like /home/ubuntu/compass-alpha.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_MAX_AGE_SECONDS,
  INCOMPLETE_MARKER,
  backupHealthScript,
  backupProblem,
  clearIncompleteScript,
  describeSnapshotScript,
  hostName,
  knownHostsFile,
  markIncompleteScript,
  restoreScript,
  rsyncExcludes,
  snapshotScript,
  sshOptions,
  stageSeedScript,
  stageTarScript,
  tarExcludes,
} from '../lib/deployRemote';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
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

/** A live tree as the previous deploy left it. */
function liveTree() {
  const home = mkdtempSync(join(tmpdir(), 'deploy-remote-'));
  dirs.push(home);
  const app = join(home, 'compass-alpha');
  put(app, 'apps/api/src/main.ts', 'old api');
  put(app, 'apps/web/dist/index.html', 'old html');
  put(app, 'apps/web/dist/build-id.txt', 'aaaaaaaaaaaa');
  put(app, 'apps/web/dist/assets/index-OLD.js', 'old js');
  put(app, 'apps/web/dist.prev/index.html', 'older html');
  put(app, 'pnpm-lock.yaml', 'old lock');
  put(app, 'node_modules/dep/index.js', 'dep');
  put(app, '.env', 'DATABASE_URL=server-secret');
  put(app, 'apps/web/.env', 'VITE_X=server');
  return { home, app, prev: join(home, 'compass-alpha.prev.tar.gz') };
}

/** What the next deploy does to that tree. */
function deployOver(app: string) {
  put(app, 'apps/api/src/main.ts', 'new api');
  put(app, 'apps/api/src/onlyInNew.ts', 'new file');
  put(app, 'pnpm-lock.yaml', 'new lock');
  rmSync(join(app, 'apps/web/dist.prev'), { recursive: true, force: true });
  bash(`cd "${app}/apps/web" && mv dist dist.prev`);
  put(app, 'apps/web/dist/index.html', 'new html');
  put(app, 'apps/web/dist/build-id.txt', 'bbbbbbbbbbbb');
  put(app, 'apps/web/dist/assets/index-NEW.js', 'new js');
  put(app, '.env', 'DATABASE_URL=server-secret-rotated');
}

describe('rollback snapshot', () => {
  test('snapshot, deploy over, restore: the old release is back, server .env untouched', () => {
    const { app, prev } = liveTree();
    const snap = bash(snapshotScript(app, prev));
    expect(snap.status).toBe(0);
    expect(snap.stdout).toContain('kept aaaaaaaaaaaa');
    expect(existsSync(`${prev}.tmp`)).toBe(false);

    const listing = bash(`tar -tzf "${prev}"`).stdout;
    expect(listing).toContain('./apps/web/dist/index.html');
    expect(listing).not.toContain('node_modules');
    expect(listing).not.toContain('dist.prev');
    expect(listing).not.toMatch(/\.env/);

    const described = bash(describeSnapshotScript(prev));
    expect(described.status).toBe(0);
    expect(described.stdout).toContain('aaaaaaaaaaaa');

    deployOver(app);
    const restored = bash(restoreScript(app, prev));
    expect(restored.status).toBe(0);
    expect(restored.stdout).toContain('restored aaaaaaaaaaaa');

    expect(read(app, 'apps/api/src/main.ts')).toBe('old api');
    expect(read(app, 'pnpm-lock.yaml')).toBe('old lock');
    expect(read(app, 'apps/web/dist/index.html')).toBe('old html');
    // The bundle is replaced wholesale, not merged.
    expect(existsSync(join(app, 'apps/web/dist/assets/index-NEW.js'))).toBe(false);
    expect(existsSync(join(app, 'apps/web/dist/assets/index-OLD.js'))).toBe(true);
    expect(existsSync(join(app, 'apps/web/dist.bad'))).toBe(false);
    // Server-owned files are left alone.
    expect(read(app, '.env')).toBe('DATABASE_URL=server-secret-rotated');
    expect(read(app, 'apps/web/.env')).toBe('VITE_X=server');
    expect(existsSync(join(app, 'node_modules/dep/index.js'))).toBe(true);
    // Like a deploy, extraction does not delete: documented in RUNBOOK.
    expect(existsSync(join(app, 'apps/api/src/onlyInNew.ts'))).toBe(true);
  });

  test('a tree without a built bundle is not snapshotted, and the old snapshot survives', () => {
    const { app, prev } = liveTree();
    expect(bash(snapshotScript(app, prev)).status).toBe(0);
    const before = readFileSync(prev);
    rmSync(join(app, 'apps/web/dist'), { recursive: true });
    expect(bash(snapshotScript(app, prev)).status).not.toBe(0);
    expect(readFileSync(prev).equals(before)).toBe(true);
  });

  test('no snapshot: describe says so and restore changes nothing', () => {
    const { app, prev } = liveTree();
    const d = bash(describeSnapshotScript(prev));
    expect(d.status).toBe(3);
    expect(d.stderr).toContain('no previous release');
    expect(bash(restoreScript(app, prev)).status).not.toBe(0);
    expect(read(app, 'apps/web/dist/index.html')).toBe('old html');
  });

  test('a corrupt snapshot fails before the live bundle is touched', () => {
    const { app, prev } = liveTree();
    writeFileSync(prev, 'not a tarball');
    expect(bash(restoreScript(app, prev)).status).not.toBe(0);
    expect(read(app, 'apps/web/dist/index.html')).toBe('old html');
  });
});

// Review OPS-01 (2026-11-09): a deploy that failed after extracting left a
// tree that never ran, and the next deploy kept it as its rollback point.
describe('a deploy that stopped after extracting', () => {
  test('is not kept as the rollback point: the snapshot from before it stays', () => {
    const { app, prev } = liveTree();
    expect(bash(snapshotScript(app, prev)).status).toBe(0);
    expect(bash(markIncompleteScript('bbbbbbbbbbbb', app)).status).toBe(0);
    expect(read(app, INCOMPLETE_MARKER)).toMatch(/^bbbbbbbbbbbb \d{4}-\d\d-\d\dT/);
    put(app, 'apps/api/src/main.ts', 'new api, never started');

    const snap = bash(snapshotScript(app, prev));
    expect(snap.status).toBe(0);
    expect(snap.stdout).toContain('the last deploy did not finish (bbbbbbbbbbbb');
    expect(bash(`tar -xzOf "${prev}" ./apps/api/src/main.ts`).stdout).toBe('old api');
  });

  test('with no earlier snapshot the deploy stops before extracting', () => {
    const { app, prev } = liveTree();
    bash(markIncompleteScript('bbbbbbbbbbbb', app));
    const snap = bash(snapshotScript(app, prev));
    expect(snap.status).toBe(4);
    expect(snap.stderr).toContain('no earlier snapshot');
    expect(existsSync(prev)).toBe(false);
  });

  test('putting the kept release back clears the mark', () => {
    const { app, prev } = liveTree();
    bash(snapshotScript(app, prev));
    bash(markIncompleteScript('bbbbbbbbbbbb', app));
    deployOver(app);
    expect(bash(restoreScript(app, prev)).status).toBe(0);
    expect(read(app, 'apps/api/src/main.ts')).toBe('old api');
    expect(existsSync(join(app, INCOMPLETE_MARKER))).toBe(false);
  });

  test('a finished deploy clears the mark and is kept next time', () => {
    const { app, prev } = liveTree();
    bash(markIncompleteScript('bbbbbbbbbbbb', app));
    expect(bash(clearIncompleteScript(app)).status).toBe(0);
    expect(existsSync(join(app, INCOMPLETE_MARKER))).toBe(false);
    expect(bash(snapshotScript(app, prev)).stdout).toContain('kept aaaaaaaaaaaa');
  });
});

// Review OPS-02 (2026-11-09): backups failed silently from 2026-08 to 11.
describe('backup health before a deploy', () => {
  const healthy = 'timer=active\nunit=inactive\nlatest=/b/compass-2026-11-09-033000.dump\nage=3600';

  test('a running timer, a clean last run and a recent dump pass', () => {
    expect(backupProblem(healthy)).toBeNull();
  });

  test('each way of failing is named', () => {
    expect(backupProblem(healthy.replace('timer=active', 'timer=inactive'))).toContain(
      'timer is not running (compass-backup.timer: inactive)',
    );
    expect(backupProblem(healthy.replace('timer=active', 'timer='))).toContain('not installed');
    expect(backupProblem(healthy.replace('unit=inactive', 'unit=failed'))).toContain(
      'last backup run failed',
    );
    expect(backupProblem('timer=active\nunit=inactive\nlatest=\nage=-1')).toBe(
      'there is no backup file',
    );
    expect(backupProblem(healthy.replace('age=3600', `age=${BACKUP_MAX_AGE_SECONDS + 7200}`))).toBe(
      'the newest backup is 28 hours old (/b/compass-2026-11-09-033000.dump)',
    );
  });

  test('the script finds the newest dump and its age', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backups-'));
    dirs.push(dir);
    put(dir, 'compass-2026-11-07-033000.dump', 'old');
    put(dir, 'compass-2026-11-08-033000.dump', 'new');
    bash(`touch -d '50 hours ago' "${dir}/compass-2026-11-07-033000.dump"`);
    bash(`touch -d '2 hours ago' "${dir}/compass-2026-11-08-033000.dump"`);
    const out = bash(backupHealthScript(dir)).stdout;
    expect(out).toContain(`latest=${dir}/compass-2026-11-08-033000.dump`);
    const age = Number(/^age=(-?\d+)$/m.exec(out)?.[1]);
    expect(age).toBeGreaterThanOrEqual(7200);
    expect(age).toBeLessThan(7300);
  });

  test('an empty folder reports no dump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backups-'));
    dirs.push(dir);
    const out = bash(backupHealthScript(dir)).stdout;
    expect(out).toContain('latest=\n');
    expect(out).toContain('age=-1');
  });
});

describe('host key verification', () => {
  test('ssh options require a pinned key and never add one', () => {
    const o = sshOptions('/k/key.pem', '/repo/infra/deploy/known_hosts');
    expect(o).toContain('StrictHostKeyChecking=yes');
    expect(o).toContain('UserKnownHostsFile="/repo/infra/deploy/known_hosts"');
    expect(o).not.toContain('StrictHostKeyChecking=no');
  });

  test('ssh resolves those options as written (ssh -G, no connection)', () => {
    const kh = knownHostsFile(ROOT, {});
    const g = bash(`ssh -G ${sshOptions('/dev/null', kh)} ubuntu@129.204.59.183`);
    expect(g.status).toBe(0);
    expect(g.stdout).toMatch(/^stricthostkeychecking (yes|true)$/m);
    expect(g.stdout).toContain(`userknownhostsfile ${kh}`);
  });

  test('the production host is pinned in the repo file; env overrides the file', () => {
    const kh = knownHostsFile(ROOT, {});
    expect(kh).toBe(join(ROOT, 'infra', 'deploy', 'known_hosts'));
    expect(knownHostsFile(ROOT, { COMPASS_DEPLOY_KNOWN_HOSTS: '/x/kh' })).toBe('/x/kh');
    const host = hostName('ubuntu@129.204.59.183');
    expect(host).toBe('129.204.59.183');
    expect(bash(`ssh-keygen -F ${host} -f "${kh}"`).status).toBe(0);
    expect(bash(`ssh-keygen -F compass-pro.com -f "${kh}"`).status).not.toBe(0);
  });
});

describe('incremental upload', () => {
  const hasRsync = spawnSync('rsync', ['--version']).status === 0;
  /** A repo tree with things that must never ship. */
  function repo(base: string) {
    const r = join(base, 'CompassAlpha');
    put(r, 'package.json', '{}');
    put(r, 'apps/api/src/main.ts', 'main v1');
    put(r, 'apps/web/src/a.ts', 'a');
    put(r, 'apps/web/dist/index.html', 'built');
    put(r, 'apps/api/node_modules/x/index.js', 'dep');
    put(r, 'node_modules/y/index.js', 'dep');
    put(r, '.env', 'SECRET=1');
    put(r, 'apps/web/.env.local', 'VITE_DEV=1');
    put(r, 'packages/db/.env', 'DB=1');
    put(r, '.git/HEAD', 'ref');
    put(r, '.claude/worktrees/w/x', 'x');
    put(r, '.worktrees/w/.env', 'BOT=1');
    put(r, 'infra/key.pem', 'KEY');
    put(r, 'deploy.log', 'log');
    return r;
  }
  function listing(tarball: string) {
    const out = bash(`tar tzf "${tarball}" | grep -v '/$' | sort`);
    expect(out.status).toBe(0);
    return out.stdout.trim().split('\n');
  }

  test.skipIf(!hasRsync)(
    'the staged tarball equals a full one; deletions and changes carry over',
    () => {
      const base = mkdtempSync(join(tmpdir(), 'ship-'));
      dirs.push(base);
      const local = join(base, 'local');
      const r = repo(local);
      const server = join(base, 'server');
      mkdirSync(server);
      const stage = join(server, 'src');
      const tarball = join(server, 'deploy.tar.gz');

      // The last full upload is still on the server: the stage is seeded from it.
      expect(
        bash(`cd "${local}" && tar ${tarExcludes()} -czf "${tarball}" CompassAlpha`).status,
      ).toBe(0);
      const full = listing(tarball);
      expect(full).toEqual([
        'CompassAlpha/apps/api/src/main.ts',
        'CompassAlpha/apps/web/src/a.ts',
        'CompassAlpha/package.json',
      ]);
      const seeded = bash(stageSeedScript(stage, tarball));
      expect([seeded.status, seeded.stdout.trim()]).toEqual([0, 'seeded']);
      expect(bash(stageSeedScript(stage, tarball)).stdout.trim()).toBe('ready');

      // A change, a new file and a deleted file; then rsync and rebuild.
      put(r, 'apps/api/src/main.ts', 'main v2');
      put(r, 'apps/api/src/new.ts', 'new');
      rmSync(join(r, 'apps/web/src/a.ts'));
      const sync = bash(
        `cd "${r}" && rsync -rlptc --delete --delete-excluded ${rsyncExcludes()} ./ "${stage}/CompassAlpha/"`,
      );
      expect(sync.status).toBe(0);
      expect(bash(stageTarScript(stage, tarball)).status).toBe(0);

      const fresh = join(base, 'fresh.tar.gz');
      expect(
        bash(`cd "${local}" && tar ${tarExcludes()} -czf "${fresh}" CompassAlpha`).status,
      ).toBe(0);
      expect(listing(tarball)).toEqual(listing(fresh));
      expect(listing(tarball)).toEqual([
        'CompassAlpha/apps/api/src/main.ts',
        'CompassAlpha/apps/api/src/new.ts',
        'CompassAlpha/package.json',
      ]);
      const out = join(base, 'out');
      mkdirSync(out);
      expect(bash(`tar xzf "${tarball}" -C "${out}"`).status).toBe(0);
      expect(read(out, 'CompassAlpha/apps/api/src/main.ts')).toBe('main v2');
    },
  );

  test('no earlier tarball: an empty stage, and rsync sends everything', () => {
    const base = mkdtempSync(join(tmpdir(), 'ship-'));
    dirs.push(base);
    const stage = join(base, 'src');
    const r = bash(stageSeedScript(stage, join(base, 'missing.tar.gz')));
    if (spawnSync('rsync', ['--version']).status !== 0) {
      expect(r.status).not.toBe(0);
      return;
    }
    expect([r.status, r.stdout.trim()]).toEqual([0, 'empty']);
    expect(existsSync(join(stage, 'CompassAlpha'))).toBe(true);
  });
});
