/**
 * DX-COPY-11 / DX-COPY-26 (2026-11-01): a unit printed after a quantity
 * agrees with it. The counted units are plural blocks in en / ru, and
 * `unitLabel(unit)` without the quantity is the dictionary form, so
 * `${formatQty(qty)} ${unitLabel(unit)}` read «0 пара» / "2 pack" to
 * staff and screen readers. A one-argument call is right only where no
 * number stands next to it (unit pickers, "per kg" prices, the "Unit: …"
 * caption); those are listed below with the reason.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../..', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** `file: call` → why the unit stands without a count. */
const SINGULAR_ALLOWED: Record<string, string> = {
  'pages/admin/operations/OperationsSections.tsx: unitLabel(r.unit)': 'price per unit ("/ kg")',
  'pages/admin/operations/OperationsSections.tsx: unitLabel(sku.unit)':
    'unit column of the copied table',
  'pages/runs/sheets/RunSheets.tsx: unitLabel(sku.unit)':
    'field label "Actual quantity (kg)" and the unit next to a typed price',
  'pages/runs/sheets/RunSheets.tsx: unitLabel(selectedSku.unit)': 'unit caption of a picked product',
  'pages/runs/sheets/RunSheets.tsx: unitLabel(selectedSku?.unit)': 'field label "Actual quantity (kg)"',
  'pages/OrderPage.tsx: unitLabel(u)': 'unit picker option',
  'pages/runs/views/RunViews.tsx: unitLabel(unitCode)': 'unit caption; quantities use unitFor',
  "pages/ApprovalPage.tsx: unitLabel(sku?.unit ?? '')": 'price per unit ("~12,000 / kg")',
  'pages/admin/catalog/CatalogSections.tsx: unitLabel(sk.unit)': 'product row: category · unit',
  'pages/admin/catalog/CatalogSections.tsx: unitLabel(u)': 'unit picker option',
  'pages/admin/catalog/CatalogSections.tsx: unitLabel(sku.unit)': 'recipe row unit caption',
};

/** Each `unitLabel(…)` call in `src` with its argument count. */
function calls(src: string): Array<{ text: string; args: number; at: number }> {
  const found: Array<{ text: string; args: number; at: number }> = [];
  for (const m of src.matchAll(/\bunitLabel\(/g)) {
    let depth = 0;
    let commas = 0;
    let i = m.index! + 'unitLabel'.length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) break;
      } else if (ch === ',' && depth === 1) commas++;
    }
    const text = src.slice(m.index!, i + 1);
    const empty = /^unitLabel\(\s*\)$/.test(text);
    found.push({ text, args: empty ? 0 : commas + 1, at: m.index! });
  }
  return found;
}

/** One-argument calls that are not on the list. */
function offenders(file: string, src: string): string[] {
  const out: string[] = [];
  for (const c of calls(src)) {
    if (c.args !== 1) continue;
    // QtyControl takes the dictionary form for its caption as long as the
    // same element passes unitFor for the counted text.
    const after = src.slice(c.at, c.at + 200);
    if (/^unitLabel\([^)]*\)\}\s*\n\s*unitFor=/.test(after)) continue;
    if (SINGULAR_ALLOWED[`${file}: ${c.text}`]) continue;
    out.push(`${file}: ${c.text}`);
  }
  return out;
}

describe('a unit after a quantity agrees with it', () => {
  it('passes the quantity to unitLabel wherever a number is shown with it', () => {
    const found: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const src = readFileSync(path, 'utf8');
      if (!src.includes('unitLabel(')) continue;
      found.push(...offenders(path.slice(SRC.length), src));
    }
    expect(found, `\n${found.join('\n')}\n`).toEqual([]);
  });

  it('catches the original «0 пара» call sites', () => {
    expect(offenders('x.tsx', '`${formatQty(l.qty)} ${unitLabel(sku.unit)}`')).toEqual([
      'x.tsx: unitLabel(sku.unit)',
    ]);
    expect(offenders('x.tsx', '<QtyControl unit={unitLabel(sku.unit)} />')).toHaveLength(1);
    expect(
      offenders(
        'x.tsx',
        'unit={unitLabel(sku.unit)}\n        unitFor={(qty) => unitLabel(sku.unit, qty)}',
      ),
    ).toEqual([]);
    expect(offenders('x.tsx', '{formatQty(r.qty)} {unitLabel(r.unit, r.qty)}')).toEqual([]);
  });
});
