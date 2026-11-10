/**
 * Every tracked text file is valid UTF-8 and holds no U+FFFD (review,
 * 2026-11-10). Five code comments had carried "�?" since the first commit:
 * an em dash whose last byte had become "?", later rewritten as the
 * replacement character. Nobody reading them could tell it was a dash.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

/** Model files and other binaries; anything else with a NUL byte is skipped too. */
const BINARY = /\.(onnx|task|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tgz|wasm)$/i;

/** Files that contain the replacement character on purpose. */
const ALLOWED = new Set([
  // Its mojibake rule matches U+FFFD in catalog values.
  'packages/i18n/src/__tests__/catalog-lint.test.ts',
]);

function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '' && !BINARY.test(file));
}

describe('tracked text files', () => {
  test('are valid UTF-8 without a replacement character', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const problems: string[] = [];
    for (const file of trackedTextFiles()) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(ROOT, file));
      } catch {
        continue; // deleted in the working tree, not yet in the index
      }
      if (bytes.includes(0)) continue;
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        problems.push(`${file}: not valid UTF-8`);
        continue;
      }
      if (ALLOWED.has(file)) continue;
      text.split('\n').forEach((line, i) => {
        if (line.includes('�')) problems.push(`${file}:${i + 1}`);
      });
    }
    expect(problems).toEqual([]);
  });
});
