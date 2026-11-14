/**
 * Every error key the server throws has a sentence in the catalogs
 * (B15, 2026-10-30): 17 were missing, so users saw raw keys such as
 * order.errors.tooManyExtras. This scans the API and domain sources.
 * 2026-10-31: the development / test sign-in keys are in the catalogs too
 * (RE-COPY-9), so there is no exception list any more.
 * 2026-11-11 (TEST2-15): the contracts (zod messages the web shows too) and
 * the worker are scanned as well, and keys written in backticks count. The
 * one key built at run time, attendance's `fail()`, is checked by tsc
 * instead: its `key` is typed from the catalog. Only en is read: the other
 * catalogs must have every en key, or the type-check fails.
 * 2026-11-12 (ORD-07): packages/streams too, where the order projector
 * (and its ConcurrentDraftError) moved.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Where a key can reach a user from: thrown, or a zod message. */
const SCANNED = [
  'apps/api/src',
  'apps/worker/src',
  'packages/domain/src',
  'packages/contracts/src',
  'packages/streams/src',
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/** A quoted string without `${}`: '…', "…" or `…`. */
const STRING = String.raw`'[^'\n]*'|"[^"\n]*"|\`[^\`$\n]*\``;
/** A regex literal; a character class may hold a slash or a comma. */
const REGEX = String.raw`/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n\[])+/[a-z]*`;
/** The argument before a check's message: a regex, a number, a name, a call. */
const ARG = String.raw`(?:${REGEX}|[^,()'"\`/]|\((?:[^()]|\([^()]*\))*\))*?`;
/**
 * Where a message is written out: a `message:` (an error or a zod issue),
 * a zod type's error option, or the last argument of a zod check. A
 * message held in a constant (CONTROL_CHARS_MESSAGE, TAX_RATE_MESSAGE) is
 * not followed; the first test checks the keys those hold.
 */
const MESSAGE_LITERALS = [
  new RegExp(String.raw`(?:message|invalid_type_error|required_error):\s*(${STRING})`, 'g'),
  new RegExp(
    String.raw`\.(?:regex|refine|min|max|length|gte|lte|gt|lt|nonempty|email|url|uuid|int|positive|nonnegative)\(\s*(?:${ARG}\s*,\s*)?(${STRING})\s*,?\s*\)`,
    'g',
  ),
];

describe('thrown error keys', () => {
  test('every key the server throws is in the en catalog', () => {
    const en = readFileSync(join(ROOT, 'packages/i18n/src/catalogs/en.ts'), 'utf8');
    const known = new Set([...en.matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)].map((m) => m[1]));
    const missing = new Set<string>();
    const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir)));
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /[`'"]([a-z]+\.errors\.[a-zA-Z0-9_]+)[`'"]/g,
      )) {
        if (!known.has(m[1]!)) missing.add(m[1]!);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });

  // Review COREWEB2-19 (2026-11-12): the web reads a server message as a
  // key only in this shape (apps/web/src/lib/errorText.ts). A key sent in
  // another one (finance.range.invalid, run.history.invalidDateRange)
  // showed the caller's generic sentence instead of its own. common.error
  // is the internal-error placeholder (trpc.ts); the web shows the
  // caller's sentence for it on purpose.
  // Review ADM1-26 (2026-11-12): sentences count too, and so do the
  // messages of zod checks. Seven checks refused in English ("Telegram ID
  // must be a numeric string"), which the app cannot show, so a person saw
  // a bare failure instead of the reason.
  test('every message the server writes out has the shape the web reads as a key', () => {
    const sent: string[] = [];
    for (const file of SCANNED.flatMap((dir) => sources(join(ROOT, dir)))) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of MESSAGE_LITERALS) {
        for (const m of text.matchAll(pattern)) sent.push(m[1]!.slice(1, -1));
      }
    }
    expect(sent.length).toBeGreaterThan(100);
    const odd = sent.filter((key) => key !== 'common.error' && !/^[a-z]+\.errors\.\w+$/.test(key));
    expect([...new Set(odd)].sort()).toEqual([]);
  });

  test('the scan reads every root', () => {
    // A renamed folder would leave the test above passing on nothing.
    for (const dir of SCANNED) expect(sources(join(ROOT, dir)).length).toBeGreaterThan(0);
  });
});
