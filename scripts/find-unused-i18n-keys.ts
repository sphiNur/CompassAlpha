/**
 * Report catalog keys that no source file references (2026-07-30).
 *
 * NOT a CI gate — a triage tool. It is how the duplicate keys from the
 * 2026-07-30 i18n pass were found: eight keys had just been created that were
 * exact synonyms of keys already in the catalog, and two more
 * (admin.action.cloneRoles / .transfer) had been translated long ago while
 * their buttons still rendered English. Same failure mode as
 * admin.label.you / .noTelegram / .neverSeen — translated, never wired.
 *
 * Why it is not a gate: a key reached only through a computed prefix
 * (`i18n.t('unit.' + canonical)`) has no literal occurrence in source. The
 * scan knows about the prefixes currently in use, but a new one added without
 * updating this list would look like 90 dead keys. Run it by hand when
 * touching the catalogs; read the output, don't trust it blindly.
 *
 * Run: bun run scripts/find-unused-i18n-keys.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [
  'apps/web/src',
  'packages/ui/src',
  'apps/api/src',
  'packages/domain/src',
  // zod messages in the shared schemas are catalog keys too (run.errors.priceFormat).
  'packages/contracts/src',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      if (e === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(e)) out.push(full);
  }
  return out;
}

/**
 * R2-COPY-1 (2026-10-31): comments are dropped and a key counts only as a
 * whole quoted string. The check used to be `blob.includes(key)`, so a key
 * named in a comment (run.banner.readyToStart) or the prefix of another key
 * (settlement.expenses.item ⊂ settlement.expenses.itemNumber) looked used —
 * and so did auth.signOut, through `trpc.auth.signOut`.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Keys no source references, with the computed prefixes that were found. */
export function findUnusedKeys(
  keys: string[],
  sources: string[],
): { unused: string[]; dynamicPrefixes: string[] } {
  const blob = sources.map(stripComments).join('\n');
  // Every whole string literal ('a.b', "a.b", `a.b`).
  const literals = new Set(
    [...blob.matchAll(/(['"`])([a-z][a-zA-Z0-9._]*)\1/g)].map((m) => m[2]!),
  );
  // A key reached via `i18n.t('some.prefix.' + x)` or
  // `i18n.t(`some.prefix.${x}`)` never appears literally.
  const dynamicPrefixes = [
    ...new Set([
      ...[...blob.matchAll(/'([a-z][a-zA-Z0-9._]*\.)'\s*\+/g)].map((m) => m[1]!),
      ...[...blob.matchAll(/`([a-z][a-zA-Z0-9._]*\.)\$\{/g)].map((m) => m[1]!),
    ]),
  ].sort();
  const unused = keys.filter(
    (k) => !literals.has(k) && !dynamicPrefixes.some((p) => k.startsWith(p)),
  );
  return { unused, dynamicPrefixes };
}

if (import.meta.main) {
  const catalog = readFileSync('packages/i18n/src/catalogs/en.ts', 'utf8');
  const keys = [...catalog.matchAll(/^ {2}'([a-z][a-zA-Z0-9._]*)':/gm)].map((m) => m[1]!);
  const sources = ROOTS.flatMap((r) => walk(r)).map((f) => readFileSync(f, 'utf8'));
  const { unused, dynamicPrefixes } = findUnusedKeys(keys, sources);

  console.log(`declared keys:      ${keys.length}`);
  console.log(`dynamic prefixes:   ${dynamicPrefixes.join(', ') || '(none)'}`);
  console.log(`never referenced:   ${unused.length}`);
  if (unused.length) {
    console.log('');
    for (const k of unused) console.log('  ' + k);
    console.log('');
    console.log('Before deleting any of these, check for a computed lookup that');
    console.log('builds the key at runtime — add its prefix above if you find one.');
  }
}
