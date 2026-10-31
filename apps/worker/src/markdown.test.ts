import { describe, expect, test } from 'bun:test';
import { escapeMd } from './markdown';

describe('escapeMd (security scan F6)', () => {
  test('escapes the backslash itself, so a typed \\* stays literal', () => {
    expect(escapeMd('see \\*note')).toBe('see \\\\\\*note');
  });

  test('escapes every MarkdownV2 reserved character', () => {
    const reserved = '_*[]()~`>#+-=|{}.!\\';
    expect(escapeMd(reserved)).toBe(
      [...reserved].map((ch) => `\\${ch}`).join(''),
    );
  });

  test('leaves ordinary text alone', () => {
    expect(escapeMd('Ташкент 门店 Doʻkon 12')).toBe('Ташкент 门店 Doʻkon 12');
  });

  test('no unescaped reserved character survives, whatever the input', () => {
    for (const input of ['\\\\*', 'a\\', '\\_x_', '*bold*', '\\']) {
      const out = escapeMd(input);
      // Walk the output: every reserved character must follow a backslash
      // that is itself an escape, never a literal.
      let i = 0;
      while (i < out.length) {
        if (out[i] === '\\') {
          expect('_*[]()~`>#+-=|{}.!\\').toContain(out[i + 1]!);
          i += 2;
          continue;
        }
        expect('_*[]()~`>#+-=|{}.!\\').not.toContain(out[i]!);
        i += 1;
      }
    }
  });
});
