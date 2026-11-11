/**
 * N9 (2026-10-30): the deploy keeps the live release before extracting
 * over it and can put it back (`deploy.ts --rollback`), and ssh/scp check
 * the server's host key against the key pinned in the repo.
 *
 * The snapshot / restore scripts are run for real with bash and the local
 * tar against a scratch tree laid out like /home/ubuntu/compass-alpha.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  devBypassFiles,
  devBypassScript,
  hostName,
  knownHostsFile,
  markIncompleteScript,
  meetsVersionRange,
  pendingMigrationTags,
  pinnedToolchain,
  remoteCommand,
  remoteStepError,
  restoreScript,
  rlsRoleProblem,
  serverLimitSecs,
  snapshotScript,
  sshOptions,
  stageSeedScript,
  toolchainProblems,
  toolchainScript,
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

describe('migrations pending before a deploy (OPS-10)', () => {
  test("reads migrate.ts --pending's lines, and nothing else", () => {
    const output = [
      '$ bun run src/migrate.ts --pending',
      'pending: 0067_attendance_face_ring',
      'pending: 0068_attendance_keep_records',
      '[migrate] pending: 0070_not_ours',
      '',
    ].join('\n');
    expect(pendingMigrationTags(output)).toEqual([
      '0067_attendance_face_ring',
      '0068_attendance_keep_records',
    ]);
    expect(pendingMigrationTags('$ bun run src/migrate.ts --pending\n')).toEqual([]);
  });
});

describe('the dev login bypass in a server .env (OPS-03)', () => {
  /** A live tree with these files and no package .env (as on the server). */
  function envTree(files: Record<string, string>) {
    const app = mkdtempSync(join(tmpdir(), 'deploy-env-'));
    dirs.push(app);
    for (const [rel, body] of Object.entries(files)) put(app, rel, body);
    return app;
  }
  const check = (app: string) => bash(devBypassScript(app));

  test('a bypass in the root .env is found, though no package has an .env', () => {
    const app = envTree({
      '.env': 'DATABASE_URL=x\nVITE_DEV_MOCK_INIT_DATA=user=1\n',
      'apps/web/.env': 'VITE_X=1\n',
    });
    const r = check(app);
    expect(r.status).toBe(0);
    expect(devBypassFiles(r.stdout)).toEqual([join(app, '.env')]);
  });

  test("an app's .env is searched too", () => {
    const app = envTree({
      '.env': 'DATABASE_URL=x\n',
      'apps/web/.env': 'VITE_DEV_MOCK_INIT_DATA=user=1\n',
    });
    expect(devBypassFiles(check(app).stdout)).toEqual([join(app, 'apps/web/.env')]);
  });

  test('empty or commented out is clean, and so is a tree with no .env at all', () => {
    const app = envTree({ '.env': 'VITE_DEV_MOCK_INIT_DATA=\n# VITE_DEV_MOCK_INIT_DATA=user=1\n' });
    expect(devBypassFiles(check(app).stdout)).toEqual([]);
    expect(devBypassFiles(check(envTree({})).stdout)).toEqual([]);
  });

  // root reads any file, so the unreadable one would not be.
  test.skipIf(process.getuid?.() === 0)('an .env grep cannot read fails the check', () => {
    const app = envTree({
      '.env': 'VITE_DEV_MOCK_INIT_DATA=user=1\n',
      'apps/web/.env': 'VITE_X=1\n',
    });
    chmodSync(join(app, 'apps/web/.env'), 0o000);
    const r = check(app);
    expect(r.status).toBe(2);
    expect(() => devBypassFiles(r.stdout)).toThrow('unexpected output');
  });

  test('output that is not a verdict is not a pass', () => {
    expect(() => devBypassFiles('')).toThrow();
    expect(() => devBypassFiles('bypass\n')).toThrow();
    expect(() => devBypassFiles('/app/.env\nclean\n')).toThrow();
  });
});

describe('the database role (OPS-04)', () => {
  test('a role subject to row-level security passes', () => {
    expect(rlsRoleProblem('false,false\n')).toBeNull();
  });

  test('BYPASSRLS, a superuser, or any other answer stops the deploy', () => {
    expect(rlsRoleProblem('true,false')).toContain('BYPASSRLS');
    expect(rlsRoleProblem('true,true')).toContain('BYPASSRLS');
    expect(rlsRoleProblem('false,true')).toContain('superuser');
    expect(rlsRoleProblem('')).toContain('unexpected');
    expect(rlsRoleProblem('f,f')).toContain('unexpected');
  });
});

describe('the server toolchain (OPS-21)', () => {
  const pinned = { bun: '1.4.4', pnpm: '12.16.1', node: '>=26' };
  const said = (bun: string, pnpm: string, node: string) =>
    `bun=${bun}\npnpm=${pnpm}\nnode=${node}\n`;

  test('the script answers one line per tool, also for a tool that is not there', () => {
    const r = bash(toolchainScript());
    expect(r.status).toBe(0);
    const keys = r.stdout
      .trim()
      .split('\n')
      .map((l) => l.split('=')[0]);
    expect(keys).toEqual(['bun', 'pnpm', 'node']);
  });

  test("the repository's own pins can be read", () => {
    const own = pinnedToolchain(
      readFileSync(join(ROOT, '.bun-version'), 'utf8'),
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    );
    expect(own.bun).toMatch(/^\d+\.\d+\.\d+$/);
    expect(own.pnpm).toMatch(/^\d+\.\d+\.\d+$/);
    expect(meetsVersionRange('v999.0.0', own.node)).toBe(true);
  });

  test('pins: packageManager may carry a hash; a missing or odd pin is an error', () => {
    const pkg = (o: object) => JSON.stringify(o);
    expect(
      pinnedToolchain(
        '1.4.4\r\n',
        pkg({ packageManager: 'pnpm@12.16.1+sha512.abc', engines: { node: '>=26' } }),
      ),
    ).toEqual(pinned);
    expect(() =>
      pinnedToolchain('latest', pkg({ packageManager: 'pnpm@12.16.1', engines: { node: '>=26' } })),
    ).toThrow('.bun-version');
    expect(() =>
      pinnedToolchain('1.4.4', pkg({ packageManager: 'yarn@4.0.0', engines: { node: '>=26' } })),
    ).toThrow('packageManager');
    expect(() => pinnedToolchain('1.4.4', pkg({ packageManager: 'pnpm@12.16.1' }))).toThrow(
      'engines.node',
    );
  });

  test('version ranges: >=N[.M[.P]] or an exact version', () => {
    expect(meetsVersionRange('v26.13.0', '>=26')).toBe(true);
    expect(meetsVersionRange('v25.9.1', '>=26')).toBe(false);
    expect(meetsVersionRange('26.13.0', '>= 26.14')).toBe(false);
    expect(meetsVersionRange('v26.13.0', '26.13.0')).toBe(true);
    expect(meetsVersionRange('v26.13.1', '26.13.0')).toBe(false);
    expect(meetsVersionRange('missing', '>=26')).toBe(false);
    expect(meetsVersionRange('v26.13.0', '^26')).toBeNull();
    expect(meetsVersionRange('v26.13.0', '26')).toBeNull();
  });

  test('a server on the pins passes', () => {
    expect(toolchainProblems(said('1.4.4', '12.16.1', 'v26.13.0'), pinned)).toEqual([]);
  });

  test('each tool off its pin, or silent, is named', () => {
    const out = toolchainProblems(said('1.3.13', 'missing', 'v24.1.0'), pinned);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('1.3.13');
    expect(out[0]).toContain('.bun-version pins 1.4.4');
    expect(out[1]).toContain('pnpm is missing');
    expect(out[2]).toContain('v24.1.0');
    expect(toolchainProblems('', pinned)).toHaveLength(3);
    expect(toolchainProblems('', pinned)[0]).toContain('no answer');
  });

  test('an engines.node this check cannot read is a problem, not a pass', () => {
    const out = toolchainProblems(said('1.4.4', '12.16.1', 'v26.13.0'), { ...pinned, node: '^26' });
    expect(out).toEqual([expect.stringContaining('cannot be checked')]);
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
    // TEST-NET-3: ssh -G resolves options without connecting anywhere.
    const g = bash(`ssh -G ${sshOptions('/dev/null', kh)} ubuntu@203.0.113.10`);
    expect(g.status).toBe(0);
    expect(g.stdout).toMatch(/^stricthostkeychecking (yes|true)$/m);
    expect(g.stdout).toContain(`userknownhostsfile ${kh}`);
    // OPS-07: a dead link ends the session instead of hanging the deploy.
    expect(g.stdout).toMatch(/^connecttimeout 20$/m);
    expect(g.stdout).toMatch(/^serveraliveinterval 15$/m);
    expect(g.stdout).toMatch(/^serveralivecountmax 8$/m);
  });

  test('the production host is pinned in the repo file; env overrides the file', () => {
    const kh = knownHostsFile(ROOT, {});
    expect(kh).toBe(join(ROOT, 'infra', 'deploy', 'known_hosts'));
    expect(knownHostsFile(ROOT, { COMPASS_DEPLOY_KNOWN_HOSTS: '/x/kh' })).toBe('/x/kh');
    expect(hostName('ubuntu@203.0.113.10')).toBe('203.0.113.10');
    expect(hostName('203.0.113.10')).toBe('203.0.113.10');
    // One host, three key types, its name hashed: the repo is public and
    // does not name the server (2026-11-10).
    const lines = readFileSync(kh, 'utf8').trim().split('\n');
    expect(lines.map((l) => l.split(' ')[1]).sort()).toEqual([
      'ecdsa-sha2-nistp256',
      'ssh-ed25519',
      'ssh-rsa',
    ]);
    for (const line of lines) expect(line).toMatch(/^\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+ /);
    expect(bash(`ssh-keygen -F compass-pro.com -f "${kh}"`).status).not.toBe(0);
    // With the address at hand (the deploy's own env), all three are its.
    const target = process.env.COMPASS_DEPLOY_HOST;
    if (target) {
      const found = bash(`ssh-keygen -F ${hostName(target)} -f "${kh}"`);
      expect(found.stdout.split('\n').filter((l) => l.startsWith('|1|'))).toHaveLength(3);
    }
  });
});

describe('a step on the server (OPS-07)', () => {
  const hasTools = bash('command -v timeout && command -v flock').status === 0;
  /** A lock file in a scratch directory, for one test. */
  function scratchLock() {
    const dir = mkdtempSync(join(tmpdir(), 'remote-step-'));
    dirs.push(dir);
    return join(dir, 'deploy.lock');
  }
  /** Whether `pid` is still running (a zombie has ended). */
  function running(pid: number) {
    const stat = bash(`ps -o stat= -p ${pid}`).stdout.trim();
    return stat !== '' && !stat.startsWith('Z');
  }

  test('a failed step says how it ended, not its command line', () => {
    const failed = (status: number | null, stderr: string) =>
      Object.assign(new Error(`Command failed: ssh -i key host "echo ZWNobw== | …"\n${stderr}`), {
        status,
        stderr,
      });
    const said = (err: unknown) => (remoteStepError(err, 1110) as Error).message;
    expect(said(failed(124, ''))).toBe('the server stopped this step after 18.5 min');
    expect(said(failed(255, 'ssh: connect to host x port 22: Connection timed out\n'))).toBe(
      'ssh failed (exit 255): ssh: connect to host x port 22: Connection timed out',
    );
    expect(said(failed(2, 'psql: error: one\npsql: error: FATAL\n'))).toBe(
      'exit 2 on the server: psql: error: FATAL',
    );
    expect(said(failed(1, ''))).toBe('exit 1 on the server');
    // Killed here at its limit: the message runCapture gave it stays.
    const local = new Error('ssh did not finish within 20 min');
    expect(remoteStepError(local, 1110)).toBe(local);
  });

  test('the server ends a step a minute and a half before the deploy gives up', () => {
    expect(serverLimitSecs(20 * 60_000)).toBe(1110);
    expect(serverLimitSecs(60_000)).toBe(1);
  });

  test.skipIf(!hasTools)('runs the script as written, exit code and all', () => {
    const r = bash(remoteCommand(`echo "it's $((6 * 7))"; exit 3`, 60, scratchLock()));
    expect([r.status, r.stdout]).toEqual([3, "it's 42\n"]);
  });

  test.skipIf(!hasTools)('ends at its limit, with what it started', async () => {
    const lock = scratchLock();
    const pidFile = join(dirname(lock), 'child.pid');
    const started = Date.now();
    const r = bash(remoteCommand(`sleep 30 & echo $! > "${pidFile}"; sleep 30`, 1, lock));
    expect(r.status).toBe(124);
    expect(Date.now() - started).toBeLessThan(10_000);
    const child = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 20 && running(child); i++) await Bun.sleep(100);
    expect(running(child)).toBe(false);
  });

  test.skipIf(!hasTools)('waits for a step that still runs, within its limit', async () => {
    const lock = scratchLock();
    const held = join(dirname(lock), 'held');
    // A step from a lost connection, still holding the lock for 3 s.
    const earlier = spawn('flock', [lock, 'sh', '-c', `touch "${held}"; sleep 3`]);
    const done = new Promise((resolve) => earlier.on('exit', resolve));
    while (!existsSync(held)) await Bun.sleep(20);
    // Waiting counts toward the limit.
    expect(bash(remoteCommand('echo next', 1, lock)).status).toBe(124);
    const started = Date.now();
    const r = bash(remoteCommand('echo next', 60, lock));
    expect(r.stdout).toBe('next\n');
    expect(Date.now() - started).toBeGreaterThan(1000);
    await done;
  });
});

describe('incremental upload', () => {
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
