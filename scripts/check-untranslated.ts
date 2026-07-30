/**
 * Untranslated-literal guard (2026-07-30).
 *
 * WHY THIS EXISTS
 *
 * CI already checks i18n catalog PARITY — every catalog carries the same
 * key count, so a key present in en.ts can't be missing from zh/ru/uz.
 * That guard is blind to the failure mode that actually shipped: strings
 * that never became keys at all.
 *
 * The 2026-07-30 flow walkthrough found ~20 of them, concentrated in the
 * admin surfaces — `Edit` / `Archive` / `+ New SKU` buttons and
 * `Archive SKU "x"?` confirm dialogs rendering in English inside an
 * otherwise fully-Chinese UI. The sharpest example: within
 * CatalogSections.tsx the Dishes section correctly called
 * `i18n.t('common.archive')` while the Categories, SKUs and Suppliers
 * sections right above it shipped the literal `Archive` — and
 * `common.archive` had a Chinese translation the whole time. Parity
 * checking cannot see any of that.
 *
 * WHAT IT FLAGS
 *
 *   1. JSX text nodes that are bare ASCII words        <Button>Archive</Button>
 *   2. Sheet / dialog titles as string literals        title="New store"
 *   3. Native-confirm bodies built from ASCII template
 *      literals                                        nativeConfirm(`Archive "${n}"?`)
 *   4. aria-label / ariaLabel / placeholder props as
 *      ASCII literals                                  ariaLabel="Store section"
 *
 * WHAT IT DOESN'T
 *
 * Only user-visible surfaces are scanned (apps/web/src, packages/ui/src).
 * Anything containing a non-ASCII character is assumed already-authored
 * copy and skipped. Single ASCII words that are legitimately
 * language-neutral (units, currency codes, brand names, `UZS`, `SKU`,
 * `OK`, `ID`, `#`) are allowlisted. DebugPage is exempt in full — it is
 * an operator diagnostic screen, gated on `system.logs.view`, and is
 * intentionally English.
 *
 * Run: bun run scripts/check-untranslated.ts
 * Exit 1 with a file:line list when anything is found.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['apps/web/src', 'packages/ui/src'];

/** Files exempt in full, with the reason they're exempt. */
const EXEMPT_FILES: Array<{ match: string; why: string }> = [
  {
    match: 'pages/DebugPage.tsx',
    why: 'operator diagnostics screen, gated on system.logs.view, intentionally English',
  },
  {
    match: 'scripts/',
    why: 'not shipped to users',
  },
];

/**
 * Tokens that are the same in every language we ship, so a bare literal
 * is correct rather than a missed translation.
 */
const NEUTRAL = new Set([
  'ok',
  'id',
  'sku',
  'skus',
  'uzs',
  'usd',
  'rub',
  'kg',
  'g',
  'l',
  'ml',
  'pcs',
  'compass',
  'telegram',
  'api',
  'url',
  'json',
  'csv',
  'qr',
  'bom',
  'rls',
  'utc',
]);

/**
 * WHY THERE IS NO "PROSE" RULE (2026-07-30)
 *
 * The four rules below anchor on syntax — a prop name, a ternary of two
 * literals, a confirm() argument, a line that is nothing but bare words
 * between JSX tags. Each has a near-zero false-positive rate; I hand-checked
 * all 77 hits from the first full run.
 *
 * A fifth rule that tried to catch multi-word PROSE (the body paragraph
 * under a flagged `<Banner title=...>`) was written and then removed. Every
 * formulation traded one false-positive class for another — JSX comment
 * continuations, multi-line import specifiers, identifier lists like
 * `pendingItemCount as pendingItemCountOf,`, plain strings in .ts files.
 * Line-based scanning cannot tell a JSX text position from a comment body
 * without actually parsing, and a guard that cries wolf is worse than no
 * guard.
 *
 * The insight it produced was still worth having and is recorded here so the
 * next person doesn't have to rediscover it: **a flagged Banner/EmptyState
 * title almost always has an untranslated body next to it.** When you fix a
 * `prop:title` or `prop:description` hit, read the surrounding block and
 * translate the prose too. The count below tracks anchored strings, not total
 * debt — do not read "0 findings" as "fully localized".
 */
interface Finding {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** True when the string is plausibly translatable English UI copy. */
function looksLikeEnglishCopy(raw: string): boolean {
  const text = raw.trim();
  if (text.length < 2) return false;
  // Already-authored non-ASCII copy (zh / ru / uz Cyrillic / emoji).
  if (/[^\u0000-\u007F]/.test(text)) return false;
  // Must contain at least one run of 2+ ASCII letters to be a word.
  if (!/[A-Za-z]{2,}/.test(text)) return false;
  // Pure interpolation / punctuation / numbers.
  if (/^[\s\d.,:;!?()[\]{}<>/\|+\-*=_~`'"#$%^&@]+$/.test(text)) return false;
  // Every alphabetic token is language-neutral -> fine.
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length > 0 && words.every((w) => NEUTRAL.has(w))) return false;
  return true;
}

/**
 * Extra gate for literals found in EXPRESSION position (ternary branches,
 * prop values). A JSX text node can only ever be rendered copy, but an
 * expression-position literal is far more often an identifier: a Tailwind
 * class, a CSS custom property, a discriminated-union tag ('wss' /
 * 'numeric' / 'muted'), an inputMode, a status enum. Flagging those buried
 * the real hits 5-to-1 on the first run.
 *
 * Rendered copy in this codebase is Sentence case ("Save", "Edit SKU",
 * "No suppliers"); identifiers are lowercase or kebab/bracket-laden. So:
 * require an initial capital and reject CSS/selector punctuation.
 */
function looksLikeCopyInExpression(raw: string): boolean {
  const text = raw.trim();
  if (!looksLikeEnglishCopy(text)) return false;
  // Tailwind / CSS var / selector / path shapes.
  if (/[[\]()<>{}]|--|\/\/|::|\bvar\b/.test(text)) return false;
  // Lowercase or kebab identifier.
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(text)) return false;
  return /^[A-Z]/.test(text);
}

/**
 * Inline suppression. Put `// i18n-exempt: <reason>` on the line itself or
 * the line directly above. A reason is mandatory — the point is that the
 * next reader can tell "deliberately language-neutral" from "nobody got
 * round to it".
 */
function isExempted(lines: string[], idx: number): boolean {
  const here = lines[idx] ?? '';
  const above = lines[idx - 1] ?? '';
  return /i18n-exempt:\s*\S/.test(here) || /i18n-exempt:\s*\S/.test(above);
}

function scan(file: string): Finding[] {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const found: Finding[] = [];

  // Comment-block tracking (2026-07-30).
  //
  // The prose rule below matches an indented line of plain English
  // words -- which is exactly what the CONTINUATION lines of a JSX
  // comment or a block comment look like. Skipping lines that merely
  // START with a comment marker is not enough; this script's own
  // docblocks were the loudest thing the first prose run reported.
  //
  // So track depth across lines instead of judging each line alone.
  let inBlockComment = false;
  // Multi-line `import { a, b } from '...'`: the specifier lines look like
  // bare words to the prose rule (`pendingItemCount as pendingItemCountOf,`).
  // Skipping lines that START with `import ` misses every line but the first.
  let inImport = false;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();

    // Update state BEFORE deciding to skip, so a comment that opens and
    // closes on one line does not flip the flag.
    const opens = (line.match(/\/\*/g) ?? []).length;
    const closes = (line.match(/\*\//g) ?? []).length;
    const wasInComment = inBlockComment;
    if (opens > closes) inBlockComment = true;
    else if (closes > opens) inBlockComment = false;
    if (wasInComment || opens > 0) return;

    // Same treatment for import statements spanning several lines.
    if (/^import/.test(trimmed)) inImport = !/from|;$/.test(trimmed);
    else if (inImport && (/from/.test(trimmed) || trimmed.endsWith(';'))) {
      inImport = false;
      return;
    }
    if (inImport) return;

    // Skip comments and imports outright.
    if (
      trimmed.startsWith('//') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('import ') ||
      trimmed.startsWith('export type') ||
      trimmed.startsWith('export interface')
    ) {
      return;
    }
    if (isExempted(lines, i)) return;

    // 1. Bare JSX text node on its own line: `        Archive`
    //    Guarded to lines that are ONLY word characters + spaces, so we
    //    don't catch identifiers, JSX tags, or expressions.
    //
    //    2026-07-30: allow a leading decoration (`+ New role`, `· Runs`).
    //    The original anchor required the line to START with a letter, which
    //    let three `+ New <thing>` buttons through — they were the most
    //    visible untranslated strings left on the admin screens.
    if (
      /^[+\u00b7\u2013\u2014-]?\s*[A-Za-z][A-Za-z ]*$/.test(trimmed) &&
      looksLikeEnglishCopy(trimmed)
    ) {
      // Must be inside JSX: previous non-empty line ends with '>' and the
      // next non-empty line starts with '<'.
      const prev = lines.slice(0, i).reverse().find((l) => l.trim().length > 0) ?? '';
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0) ?? '';
      if (/>$/.test(prev.trim()) && /^<\//.test(next.trim())) {
        found.push({ file, line: lineNo, kind: 'jsx-text', text: trimmed });
      }
    }

    // 2. title= / label= / ariaLabel= / aria-label= / placeholder= with a
    //    plain string literal (single or double quoted).
    const propRe =
      /\b(title|label|ariaLabel|aria-label|placeholder|description|confirmLabel)\s*=\s*(?:\{\s*)?['"]([^'"]{2,})['"]/g;
    let m: RegExpExecArray | null;
    while ((m = propRe.exec(line))) {
      if (looksLikeCopyInExpression(m[2]!)) {
        found.push({ file, line: lineNo, kind: `prop:${m[1]}`, text: m[2]! });
      }
    }

    // 3. Ternary-shaped sheet titles: `? 'Edit SKU' : 'New SKU'`
    const ternRe = /\?\s*'([^']{2,})'\s*:\s*'([^']{2,})'/g;
    while ((m = ternRe.exec(line))) {
      for (const candidate of [m[1]!, m[2]!]) {
        if (looksLikeCopyInExpression(candidate)) {
          found.push({ file, line: lineNo, kind: 'ternary-literal', text: candidate });
        }
      }
    }

    // 4. nativeConfirm / confirmAction / confirm( with a template literal
    //    or plain string containing English.
    const confirmRe = /(nativeConfirm|confirmAction|window\.confirm|confirm)\(\s*[`'"]([^`'"]{2,})/g;
    while ((m = confirmRe.exec(line))) {
      if (looksLikeEnglishCopy(m[2]!)) {
        found.push({ file, line: lineNo, kind: 'confirm-body', text: m[2]! });
      }
    }
  });

  return found;
}

const repoRoot = process.cwd();
const files: string[] = [];
for (const root of ROOTS) {
  try {
    walk(join(repoRoot, root), files);
  } catch {
    // Root missing (partial checkout) — nothing to scan.
  }
}

const findings: Finding[] = [];
for (const file of files) {
  const rel = relative(repoRoot, file).replace(/\\/g, '/');
  if (EXEMPT_FILES.some((e) => rel.includes(e.match))) continue;
  findings.push(...scan(file).map((f) => ({ ...f, file: rel })));
}

const byFile = new Map<string, Finding[]>();
for (const f of findings) {
  const arr = byFile.get(f.file) ?? [];
  arr.push(f);
  byFile.set(f.file, arr);
}
for (const [file, fs] of [...byFile.entries()].sort()) {
  console.error(`  ${file}`);
  for (const f of fs) {
    console.error(`    ${f.line}  [${f.kind}]  ${JSON.stringify(f.text)}`);
  }
}

/**
 * HARD GATE (since 2026-07-30).
 *
 * This began as a ratchet with BASELINE = 124 -- the debt on the day the
 * guard was written. A check that fails from day one only teaches everyone
 * to ignore CI, so it allowed the count to fall but never rise.
 *
 * The backlog was then worked off in three passes: @compass/ui's own copy
 * (the QtyControl quick-pick sheet was entirely English, and it is the
 * most-used interaction in the app), the Catalog + Stores admin sections,
 * and finally Operations + People. The count reached 0.
 *
 * So there is no baseline any more: any anchored untranslated literal fails.
 *
 * Read the "WHY THERE IS NO PROSE RULE" note near the top before trusting a
 * green run -- this counts syntax-anchored strings, not total copy.
 */
if (findings.length > 0) {
  console.error(`\nUNTRANSLATED LITERALS: ${findings.length}.\n`);
  console.error('Add a key to all four catalogs (en/zh/ru/uz) and render it via i18n.t().');
  console.error(
    'Genuinely language-neutral? Add the token to NEUTRAL, or mark the line\n' +
      '`// i18n-exempt: <reason>`.\n',
  );
  process.exit(1);
}

console.log(`untranslated-literal guard: clean (${files.length} files scanned).`);
