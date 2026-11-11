/**
 * The ICU message parsing the catalog lint needs: plural blocks, the
 * placeholders a value names and the text a user sees. Only the lint uses
 * it; messages are formatted in ../index.ts.
 */
export interface PluralBlock {
  variable: string;
  cases: Map<string, string>;
}

/** Index just past the brace matching the `{` at `start`, or -1. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseCases(body: string): Map<string, string> {
  const cases = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open < 0) break;
    const end = matchBrace(body, open);
    if (end < 0) break;
    cases.set(body.slice(i, open).trim(), body.slice(open + 1, end - 1));
    i = end;
  }
  return cases;
}

/**
 * Split a value into its plural blocks and the text outside them. Each block
 * is replaced in `outside` by `⟦#⟧`, so a rule that reads the surrounding
 * sentence never mistakes a case body for plain text.
 */
export function splitPlurals(value: string): { outside: string; blocks: PluralBlock[] } {
  const blocks: PluralBlock[] = [];
  let outside = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '{') {
      outside += value[i++];
      continue;
    }
    const end = matchBrace(value, i);
    if (end < 0) {
      outside += value.slice(i);
      break;
    }
    const block = value.slice(i, end);
    const header = block.match(/^\{\s*(\w+)\s*,\s*plural\s*,/);
    if (header) {
      blocks.push({
        variable: header[1]!,
        cases: parseCases(block.slice(header[0].length, -1)),
      });
      outside += '⟦#⟧';
    } else {
      outside += block;
    }
    i = end;
  }
  return { outside, blocks };
}

/**
 * Every placeholder name in a value, including plural variables. A case
 * body is plain text, so `one {pair}` names no placeholder `pair`.
 */
export function placeholders(value: string): string[] {
  const names = new Set<string>();
  const walk = (text: string) => {
    const { outside, blocks } = splitPlurals(text);
    for (const m of outside.matchAll(/\{\s*(\w+)\s*\}/g)) names.add(m[1]!);
    for (const block of blocks) {
      names.add(block.variable);
      for (const body of block.cases.values()) walk(body);
    }
  };
  walk(value);
  return [...names].sort();
}

/** Every piece of literal text the user can see: outside text + case bodies. */
export function visibleTexts(value: string): string[] {
  const { outside, blocks } = splitPlurals(value);
  return [outside, ...blocks.flatMap((b) => [...b.cases.values()])];
}

export const CJK = /[\u3400-\u9fff]/u;
