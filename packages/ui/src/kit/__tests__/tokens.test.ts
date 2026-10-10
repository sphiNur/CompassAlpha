import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import preset, { colors, rounded, sizes, spacing, typography } from '../../../tailwind-preset.js';
import { cn } from '../../cn';

/**
 * DESIGN.md is the source of the tokens and tailwind-preset.js restates
 * them. This reads the document's front matter and fails when the two
 * have drifted, in either direction.
 */
type Tree = { [key: string]: string | Tree };

/** The front matter is nested maps of scalars; that is all this reads. */
function frontMatter(): Tree {
  const text = readFileSync(resolve(import.meta.dir, '../../../../../DESIGN.md'), 'utf8');
  const yaml = text.split(/^---$/m)[1];
  if (!yaml) throw new Error('DESIGN.md has no front matter');
  const root: Tree = {};
  const stack: Array<{ indent: number; node: Tree }> = [{ indent: -1, node: root }];
  for (const line of yaml.split('\n')) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const [, key, raw] = /^([\w-]+):\s*(.*)$/.exec(line.trim()) ?? [];
    if (!key) throw new Error(`unreadable line in DESIGN.md front matter: ${line}`);
    while (stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    if (raw === '') {
      const node: Tree = {};
      parent[key] = node;
      stack.push({ indent, node });
    } else {
      parent[key] = raw!.replace(/^"(.*)"$/, '$1');
    }
  }
  return root;
}

const doc = frontMatter();

describe('tailwind preset restates DESIGN.md', () => {
  test('colours', () => {
    expect(colors).toEqual(doc.colors as Record<string, string>);
  });

  test('spacing and radii', () => {
    expect(spacing).toEqual(doc.spacing as Record<string, string>);
    expect(rounded).toEqual(doc.rounded as Record<string, string>);
  });

  test('typography', () => {
    const fromDoc = Object.fromEntries(
      Object.entries(doc.typography as Record<string, Record<string, string>>).map(([name, t]) => [
        name,
        {
          fontSize: t.fontSize,
          fontWeight: Number(t.fontWeight),
          lineHeight: Number(t.lineHeight),
          ...(t.letterSpacing ? { letterSpacing: t.letterSpacing } : {}),
          ...(t.fontFeature === 'tnum' ? { tnum: true } : {}),
        },
      ]),
    );
    expect(typography as unknown).toEqual(fromDoc);
  });

  test('fixed heights come from the component tokens', () => {
    const c = doc.components as Record<string, Record<string, string>>;
    expect(sizes.row).toBe(c.row!.height!);
    expect(sizes.control).toBe(c['button-primary']!.height!);
    expect(sizes.tap).toBe(c['button-ghost']!.height!);
    expect(sizes.tap).toBe(c.stepper!.size!);
  });

  test('every amount style is tabular', () => {
    const utilities: Record<string, unknown> = {};
    for (const plugin of preset.plugins as Array<(api: unknown) => void>) {
      plugin({
        addUtilities: (u: Record<string, unknown>) => Object.assign(utilities, u),
        addComponents: () => {},
      });
    }
    expect(Object.keys(utilities).sort()).toEqual([
      '.text-display',
      '.text-money',
      '.text-money-lg',
    ]);
  });
});

describe('cn understands the tokens', () => {
  test('a type token survives next to a colour token', () => {
    expect(cn('text-body', 'text-secondary')).toBe('text-body text-secondary');
    expect(cn('text-money', 'text-primary')).toBe('text-money text-primary');
  });

  test('a later token of the same kind wins', () => {
    expect(cn('text-body', 'text-label')).toBe('text-label');
    expect(cn('p-lg', 'p-xl')).toBe('p-xl');
    expect(cn('h-control', 'h-tap')).toBe('h-tap');
    expect(cn('rounded-md', 'rounded-pill')).toBe('rounded-pill');
  });
});
