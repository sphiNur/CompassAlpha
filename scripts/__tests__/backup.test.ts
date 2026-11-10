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

// Review OPS-02 (2026-11-09): install.sh grants the backup role by name and
// sets default privileges for the role the migrations connect as.
describe('pg_url_parts', () => {
  const parts = (url: string) =>
    spawnSync(
      'bash',
      [
        '-c',
        `. "${join(ROOT, 'infra/backup/pg-url.sh')}"; pg_url_parts "$1"; echo "$PG_URL_USER|$PG_URL_DB"`,
        '_',
        url,
      ],
      { encoding: 'utf8' },
    ).stdout.trim();

  test('reads the user and the database, never the password', () => {
    expect(parts('postgres://compass_backup:p%40ss@localhost:5432/compass')).toBe(
      'compass_backup|compass',
    );
    expect(parts('postgres://compass@127.0.0.1/compass?sslmode=disable')).toBe('compass|compass');
  });

  test('a URL without a user or a database gives nothing', () => {
    expect(parts('postgres://localhost/compass')).toBe('|');
    expect(parts('postgres://compass@localhost')).toBe('|');
    expect(parts('')).toBe('|');
  });
});

/**
 * restore.sh with pg_restore and psql stubbed: what it refuses, what it
 * passes on, and that the password stays off the command line. The real
 * thing runs in infra/backup/drill.sh (review OPS-11, 2026-11-10).
 */
function restore(opts: {
  /** The arguments, given the dump's path; the dump alone by default. */
  args?: (dump: string) => string[];
  url?: string;
  /** RESTORE_OWNER: the role a superuser restores as. */
  owner?: string;
  /** What the check query answers: the role, whether superuser, the objects. */
  check?: string;
  envFile?: string[];
  input?: string;
}) {
  const home = mkdtempSync(join(tmpdir(), 'restore-'));
  dirs.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const dump = join(home, 'compass-x.dump');
  writeFileSync(dump, 'x');
  stub(
    bin,
    'pg_restore',
    `if [ "$1" = "--list" ]; then exit 0; fi; printf '%s\\n' "$@" > "${home}/restore.argv"; ` +
      `printf '%s' "\${PGPASSWORD-}" > "${home}/restore.pass"`,
  );
  // The check query (-c) answers `check`; a script run (-f) is recorded.
  stub(
    bin,
    'psql',
    `case " $* " in *" -c "*) printf '%s\\n' "$@" > "${home}/check.argv"; echo '${opts.check ?? 'compass|f|0'}';; ` +
      `*) printf '%s\\n' "$@" > "${home}/grant.argv"; printf '%s' "\${PGPASSWORD-}" > "${home}/grant.pass";; esac`,
  );
  if (opts.envFile) writeFileSync(join(home, '.env'), opts.envFile.join('\n') + '\n');
  const r = spawnSync('bash', [RESTORE, ...(opts.args ?? ((d) => [d]))(dump)], {
    encoding: 'utf8',
    input: opts.input ?? 'yes\n',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      ENV_FILE: join(home, '.env'),
      ...(opts.url === undefined ? {} : { RESTORE_DATABASE_URL: opts.url }),
      ...(opts.owner === undefined ? {} : { RESTORE_OWNER: opts.owner }),
    },
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(home, name), 'utf8');
    } catch {
      return null;
    }
  };
  return { r, read };
}

const NEW_DB = 'postgresql://compass:zq%3Axy@db.local/compass_restored';

describe('restore.sh', () => {
  test('F11: the password reaches pg_restore and psql through PGPASSWORD, never argv', () => {
    const { r, read } = restore({
      url: NEW_DB,
      envFile: ['BACKUP_DATABASE_URL=postgres://compass_backup:b@db.local/compass'],
    });
    expect(r.status).toBe(0);
    const argv = read('restore.argv')!;
    expect(argv).not.toContain('zq');
    expect(argv).toContain('--dbname=postgresql://compass@db.local/compass_restored');
    expect(argv).toContain('--single-transaction');
    expect(read('restore.pass')).toBe('zq:xy');
    expect(read('check.argv')).not.toContain('zq');
    expect(read('grant.argv')).not.toContain('zq');
    expect(read('grant.pass')).toBe('zq:xy');
    // The confirmation prompt shows the target without the password.
    expect(r.stdout).toContain('postgresql://compass@db.local/compass_restored');
    expect(r.stdout).not.toContain('zq%3Axy');
  }, 15_000);

  test('without RESTORE_DATABASE_URL it does nothing, whatever DATABASE_URL says', () => {
    const { r, read } = restore({ envFile: ['DATABASE_URL=postgres://compass@db.local/compass'] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('set RESTORE_DATABASE_URL');
    expect(read('check.argv')).toBeNull();
    expect(read('restore.argv')).toBeNull();
  }, 15_000);

  test('a database that is not empty is refused before pg_restore runs', () => {
    const { r, read } = restore({ url: NEW_DB, check: 'compass|f|62' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('not empty (62 tables');
    expect(read('restore.argv')).toBeNull();
  }, 15_000);

  test('a superuser is refused: the restored tables would be its own', () => {
    const { r, read } = restore({ url: NEW_DB, check: 'postgres|t|0' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('is a superuser');
    expect(r.stderr).toContain('RESTORE_OWNER');
    expect(read('restore.argv')).toBeNull();
  }, 15_000);

  test('a superuser restores as RESTORE_OWNER, which then owns the tables', () => {
    const { r, read } = restore({
      url: NEW_DB,
      owner: 'compass',
      check: 'postgres|t|0',
      envFile: ['BACKUP_DATABASE_URL=postgres://compass_backup:b@db.local/compass'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('owner:    compass');
    expect(read('restore.argv')).toContain('--role=compass\n');
    expect(read('grant.argv')).toContain('owner=compass\n');
  }, 15_000);

  test('anything but "yes" at the prompt aborts', () => {
    const { r, read } = restore({ url: NEW_DB, input: 'no\n' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('[restore] aborted');
    expect(read('restore.argv')).toBeNull();
  }, 15_000);

  test('--yes restores without asking', () => {
    const { r, read } = restore({ url: NEW_DB, input: '', args: (dump) => ['--yes', dump] });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("Type 'yes'");
    expect(read('restore.argv')).toContain('--no-owner');
  }, 15_000);

  test('the backup role gets its SELECT again, granted by the restoring role', () => {
    const { r, read } = restore({
      url: NEW_DB,
      check: 'compass_owner|f|0',
      envFile: ['BACKUP_DATABASE_URL=postgres://compass_backup:b@db.local/compass'],
    });
    expect(r.status).toBe(0);
    expect(read('restore.argv')).toContain('--role=compass_owner\n');
    const grant = read('grant.argv')!;
    expect(grant).toContain('backup=compass_backup');
    expect(grant).toContain('owner=compass_owner');
    expect(grant).toMatch(/grant-backup-role\.sql/);
    expect(r.stdout).toContain('backup role compass_backup can read the restored database');
  }, 15_000);

  test('without a backup role in the env file it says what is left to do', () => {
    const { r, read } = restore({ url: NEW_DB });
    expect(r.status).toBe(0);
    expect(read('grant.argv')).toBeNull();
    expect(r.stderr).toContain('run install.sh after the swap');
  }, 15_000);

  test('an api that connects as another role hears that it was given nothing', () => {
    const other = restore({
      url: NEW_DB,
      envFile: ['DATABASE_URL=postgres://compass_app:a@db.local/compass'],
    });
    expect(other.r.status).toBe(0);
    expect(other.r.stderr).toContain('the api connects as compass_app, which owns nothing here');
    const same = restore({
      url: NEW_DB,
      envFile: ['DATABASE_URL=postgres://compass:a@db.local/compass'],
    });
    expect(same.r.status).toBe(0);
    expect(same.r.stderr).not.toContain('the api connects as');
  }, 15_000);

  test('an unknown option is refused', () => {
    const { r, read } = restore({ url: NEW_DB, args: (dump) => ['--force', dump] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unknown option --force');
    expect(read('check.argv')).toBeNull();
  }, 15_000);
});
