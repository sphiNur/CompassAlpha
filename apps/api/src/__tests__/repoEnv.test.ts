/**
 * The .env reader every entry point shares (packages/db/src/repoEnv.ts).
 * It is tested here because CI's unit job does not run packages/db.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRepoEnv, parseEnv } from '@compass/db/env';

describe('reading .env text', () => {
  test('one KEY=value per line, trimmed; blank, comment and =-less lines are skipped', () => {
    const text = 'A=1\n\n# a note\nnot a pair\n  B =  two words  \r\nC=\n';
    expect(parseEnv(text)).toEqual({ A: '1', B: 'two words', C: '' });
  });

  test('a quoted value is taken as written between its quotes', () => {
    const text = [
      'A="x # y"',
      "B='  padded  '",
      'C="postgres://u:p@localhost/compass_test" # dev database',
      'D=""',
    ].join('\n');
    expect(parseEnv(text)).toEqual({
      A: 'x # y',
      B: '  padded  ',
      C: 'postgres://u:p@localhost/compass_test',
      D: '',
    });
  });

  test('an unquoted value ends at a " #" comment; a # inside it stays', () => {
    const text = 'A=abc # trailing note\nB=pa#ss\nC=redis://localhost:6380#0';
    expect(parseEnv(text)).toEqual({ A: 'abc', B: 'pa#ss', C: 'redis://localhost:6380#0' });
  });

  test('an export prefix is not part of the key', () => {
    expect(parseEnv('export A=1\nexport   B="2"')).toEqual({ A: '1', B: '2' });
  });

  test('a value whose opening quote is never closed is kept as written', () => {
    expect(parseEnv('A="abc')).toEqual({ A: '"abc' });
  });
});

describe('loading the repository .env', () => {
  const keys = ['REPO_ENV_TEST_FROM_FILE', 'REPO_ENV_TEST_ALREADY_SET', 'REPO_ENV_TEST_STRAY'];
  const roots: string[] = [];

  function tempTree(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'repo-env-'));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  afterEach(() => {
    for (const key of keys) delete process.env[key];
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('reads the .env beside pnpm-workspace.yaml above the caller; a variable already set wins', () => {
    const root = tempTree({
      'pnpm-workspace.yaml': 'packages: []\n',
      '.env': 'REPO_ENV_TEST_FROM_FILE=file\nREPO_ENV_TEST_ALREADY_SET=file\n',
      'apps/api/src/.keep': '',
    });
    process.env.REPO_ENV_TEST_ALREADY_SET = 'shell';

    const read = loadRepoEnv(pathToFileURL(join(root, 'apps/api/src/env.ts')).href);

    expect(read).toBe(join(root, '.env'));
    expect(process.env.REPO_ENV_TEST_FROM_FILE).toBe('file');
    expect(process.env.REPO_ENV_TEST_ALREADY_SET).toBe('shell');
  });

  test('a .env with no pnpm-workspace.yaml beside it is not the repository one', () => {
    const root = tempTree({ '.env': 'REPO_ENV_TEST_STRAY=1\n', 'src/.keep': '' });

    const read = loadRepoEnv(pathToFileURL(join(root, 'src/main.ts')).href);

    expect(read).not.toBe(join(root, '.env'));
    expect(process.env.REPO_ENV_TEST_STRAY).toBeUndefined();
  });
});
