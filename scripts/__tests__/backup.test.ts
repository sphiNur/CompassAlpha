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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, 'infra/backup/compass-backup.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stub(bin: string, name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function setup(opts: { s3?: boolean; aws?: 'ok' | 'fail' | 'missing'; dump?: 'ok' | 'fail' }) {
  const home = mkdtempSync(join(tmpdir(), 'backup-'));
  dirs.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const env = [
    'DATABASE_URL=postgres://app@localhost/compass',
    'BACKUP_DATABASE_URL=postgres://backup@localhost/compass',
    ...(opts.s3 ? ['BACKUP_S3_BUCKET=bucket'] : []),
  ];
  writeFileSync(join(home, '.env'), env.join('\n') + '\n');
  stub(
    bin,
    'pg_dump',
    opts.dump === 'fail'
      ? 'echo "pg_dump: error: connection refused" >&2; exit 1'
      : 'for a in "$@"; do case "$a" in --file=*) head -c 4096 /dev/zero > "${a#--file=}";; esac; done',
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
  return { r, dumps };
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
});
