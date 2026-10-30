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
  describeSnapshotScript,
  hostName,
  knownHostsFile,
  restoreScript,
  snapshotScript,
  sshOptions,
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
