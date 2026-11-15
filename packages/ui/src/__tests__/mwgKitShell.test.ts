/**
 * MWG review (2026-11-15, modern-web-guidance: dialog, typography,
 * customize-scrollbar-color-and-thickness, color, forms): the kit fixes
 * from the conformance audit.
 */
import { describe, expect, test } from 'bun:test';
import * as Dialog from '@radix-ui/react-dialog';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Avatar } from '../components/Avatar';
import { SHEET_CLOSE_FALLBACK, SHEET_TITLE_INSET, SheetCloseButton } from '../components/Sheet';
import { TOKENS_CSS, UI_SRC } from '../testing/tokenCss';

const read = (name: string) => readFileSync(join(UI_SRC, 'components', name), 'utf8');
const css = TOKENS_CSS;

describe('the sheet shows a close button (dialog)', () => {
  test('a named Radix close, 44 px to tap, at the top end corner', () => {
    const html = renderToStaticMarkup(
      createElement(
        Dialog.Root,
        { open: true },
        createElement(SheetCloseButton, { label: 'Закрыть' }),
      ),
    );
    expect(html).toContain('aria-label="Закрыть"');
    expect(html).toContain('type="button"');
    expect(html).toContain('data-sheet-close=""');
    expect(html).toContain('hit-44');
    expect(html).toMatch(/\bend-2\b/);
  });

  test('every sheet renders it after its content, and its text keeps clear of it', () => {
    const sheet = read('Sheet.tsx');
    expect(sheet).toContain('<SheetCloseButton label={labels.close ?? SHEET_CLOSE_FALLBACK} />');
    // Last in the content: the first field still takes the autofocus.
    expect(sheet.indexOf('<SheetCloseButton label')).toBeGreaterThan(
      sheet.indexOf('<SheetFooter>{footer}</SheetFooter>'),
    );
    // Title and description pad both sides past the 44 px tap area.
    expect(sheet.match(/SHEET_TITLE_INSET,\n/g)?.length).toBe(2);
    expect(SHEET_TITLE_INSET).toBe('px-8');
    expect(SHEET_CLOSE_FALLBACK).toBe('Close');
  });
});

describe('text controls grow with the text size (typography)', () => {
  test('Input, Select and SearchInput take a minimum height, not a fixed one', () => {
    for (const name of ['Input.tsx', 'Select.tsx', 'SearchInput.tsx']) {
      const src = read(name);
      expect({ name, min: src.includes("'min-h-[var(--control-h)] py-2.5") }).toEqual({
        name,
        min: true,
      });
      expect({ name, fixed: /[' ]h-\[var\(--control-h\)\]/.test(src) }).toEqual({
        name,
        fixed: false,
      });
    }
  });

  test('Segmented sets minimum heights', () => {
    const src = read('Segmented.tsx');
    expect(src).toContain("isSm ? 'min-h-7' : 'min-h-[var(--control-h-sm)]'");
    expect(src).not.toMatch(/'h-7'|' h-\[var\(--control-h-sm\)\]'/);
  });

  test('Avatar initials are in rem, capped at half the circle', () => {
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Smoke Admin', size: 32 }));
    expect(html).toContain('font-size:min(0.84rem, 16px)');
  });
});

describe('tokens.css (scrollbars, forced colors, textarea)', () => {
  test('a fine pointer sees a thin chip-strip scrollbar', () => {
    const block = /@media \(pointer: fine\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
    expect(block).toContain('.scrollbar-hide {');
    expect(block).toContain('scrollbar-width: thin;');
  });

  test('the nav capsule, the dock hint and the main button are outlined in forced colors', () => {
    const block = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
    expect(block).toMatch(
      /\.app-nav::before,\s*\.app-dock-hint \{\s*outline: 1px solid CanvasText;/,
    );
    expect(block).toMatch(/\.app-main-btn \{\s*outline: 1px solid ButtonText;/);
    // Before :focus-visible, which must win on a focused main button.
    expect(block.indexOf('.app-main-btn {')).toBeLessThan(block.indexOf(':focus-visible {'));
  });

  test('the textarea loses its resize handle only where it grows by itself', () => {
    expect(read('Textarea.tsx')).not.toContain('resize-none');
    expect(css).toMatch(/textarea\.textarea-grow \{\s*resize: vertical;\s*\}/);
    expect(css).toMatch(
      /@supports \(field-sizing: content\) \{\s*textarea\.textarea-grow \{\s*resize: none;/,
    );
  });

  test('the photo preview keeps its height before the photo loads', () => {
    expect(read('PhotoCapture.tsx')).toContain('className="block h-40 w-auto max-w-full');
  });
});
