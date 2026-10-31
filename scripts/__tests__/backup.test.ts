/**
 * infra/backup/compass-backup.sh must fail loudly (2026-10-30): a failed
 * dump or — once BACKUP_S3_BUCKET is configured — a failed off-site
 * upload exits non-zero with an ERROR/FAILED line, instead of WARN + 0.
 *
 * pg_dump, pg_restore and aws are stubbed on PATH; nothing touches a
 * database or the network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, 'infra/backup/compass-backup.sh');
const RESTORE = join(ROOT, 'infra/backup/restore.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function setup(opts: {
  s3?: boolean;
  aws?: 'ok' | 'fail' | 'missing';
  dump?: 'ok' | 'fail';
  backupUrl?: string;
}) {
  const home = mkdtempSync(join(tmpdir(), 'backup-'));
  dirs.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const env = [
    'DATABASE_URL=postgres://app@localhost/compass',
    `BACKUP_DATABASE_URL=${opts.backupUrl ?? 'postgres://backup@localhost/compass'}`,
    ...(opts.s3 ? ['BACKUP_S3_BUCKET=bucket'] : []),
  ];
  writeFileSync(join(home, '.env'), env.join('\n') + '\n');
  stub(
    bin,
    'pg_dump',
    opts.dump === 'fail'
      ? 'echo "pg_dump: error: connection refused" >&2; exit 1'
      : // Records what a local `ps` would see (argv) and the password env.
        `printf '%s\\n' "$@" > "${home}/pg_dump.argv"; printf '%s' "\${PGPASSWORD-}" > "${home}/pg_dump.pass"; ` +
          'for a in "$@"; do case "$a" in --file=*) head -c 4096 /dev/zero > "${a#--file=}";; esac; done',
  );
  stub(bin, 'pg_restore', 'exit 0');
  if (opts.aws === 'ok') stub(bin, 'aws', 'exit 0');
  if (opts.aws === 'fail') stub(bin, 'aws', 'echo "upload failed: AccessDenied" >&2; exit 1');
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      ENV_FILE: join(home, '.env'),
      BACKUP_DIR: join(home, 'backups'),
    },
  });
  const dumps = (() => {
    try {
      return readdirSync(join(home, 'backups')).filter((f) => f.endsWith('.dump'));
    } catch {
      return [];
    }
  })();
  return { r, dumps, home };
}

describe('compass-backup.sh', () => {
  test('a good run without off-site storage exits 0', () => {
    const { r, dumps } = setup({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[backup] done');
    expect(dumps).toHaveLength(1);
  }, 15_000);

  test('a good run with a working upload exits 0', () => {
    const { r } = setup({ s3: true, aws: 'ok' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[backup] uploaded');
  }, 15_000);

  test('a failed pg_dump exits non-zero and says FAILED', () => {
    const { r, dumps } = setup({ dump: 'fail' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('[backup] FAILED');
    expect(dumps).toHaveLength(0);
  }, 15_000);

  test('a failed upload exits non-zero and keeps the local dump', () => {
    const { r, dumps } = setup({ s3: true, aws: 'fail' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('[backup] ERROR: S3 upload failed');
    expect(dumps).toHaveLength(1);
  }, 15_000);

  test('off-site configured but no aws CLI exits non-zero', () => {
    const { r, dumps } = setup({ s3: true, aws: 'missing' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("'aws' CLI is not installed");
    expect(dumps).toHaveLength(1);
  }, 15_000);

  test('F11: the password reaches pg_dump through PGPASSWORD, never argv', () => {
    const { r, home } = setup({
      backupUrl: 'postgres://compass_backup:s3cr%40t%2Fpw@127.0.0.1:5432/compass?sslmode=disable',
    });
    expect(r.status).toBe(0);
    const argv = readFileSync(join(home, 'pg_dump.argv'), 'utf8');
    expect(argv).not.toContain('s3cr');
    expect(argv).toContain('postgres://compass_backup@127.0.0.1:5432/compass?sslmode=disable');
    expect(readFileSync(join(home, 'pg_dump.pass'), 'utf8')).toBe('s3cr@t/pw');
  }, 15_000);

  test('F11: a URL without a password is passed as it is', () => {
    const { r, home } = setup({});
    expect(r.status).toBe(0);
    expect(readFileSync(join(home, 'pg_dump.argv'), 'utf8')).toContain(
      'postgres://backup@localhost/compass',
    );
    expect(readFileSync(join(home, 'pg_dump.pass'), 'utf8')).toBe('');
  }, 15_000);
});

describe('restore.sh (F11)', () => {
  test('the password reaches pg_restore through PGPASSWORD, never argv', () => {
    const home = mkdtempSync(join(tmpdir(), 'restore-'));
    dirs.push(home);
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const dump = join(home, 'compass-x.dump');
    writeFileSync(dump, 'x');
    stub(
      bin,
      'pg_restore',
      `if [ "$1" = "--list" ]; then exit 0; fi; printf '%s\\n' "$@" > "${home}/argv"; printf '%s' "\${PGPASSWORD-}" > "${home}/pass"`,
    );
    const r = spawnSync('bash', [RESTORE, dump], {
      encoding: 'utf8',
      input: 'yes\n',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        ENV_FILE: join(home, 'missing.env'),
        DATABASE_URL: 'postgresql://compass:zq%3Axy@db.local/compass',
      },
    });
    expect(r.status).toBe(0);
    const argv = readFileSync(join(home, 'argv'), 'utf8');
    expect(argv).not.toContain('zq');
    expect(argv).toContain('--dbname=postgresql://compass@db.local/compass');
    expect(readFileSync(join(home, 'pass'), 'utf8')).toBe('zq:xy');
    // The confirmation prompt still hides the credentials.
    expect(r.stdout).not.toContain('zq%3Axy');
  }, 15_000);
});
