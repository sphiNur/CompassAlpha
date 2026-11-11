/**
 * The confirmation prompt (lib/confirm.ts, review COREWEB2-16): Telegram's
 * popup throws on a long message, a second popup or an old client, and
 * each of those used to leave the action doing nothing.
 */
import { describe, expect, test } from 'bun:test';
import {
  TELEGRAM_POPUP_MAX,
  confirmIn,
  flattenParagraphs,
  popupText,
  type ConfirmHost,
} from '../confirm';

/** A Telegram client that answers `answer`, or throws `error`; it records what it showed. */
function client(opts: { platform?: string; answer?: boolean; error?: string } = {}) {
  const shown: string[] = [];
  const tg: ConfirmHost = {
    platform: opts.platform ?? 'android',
    showConfirm(message, cb) {
      if (opts.error) throw new Error(opts.error);
      shown.push(message);
      cb(opts.answer ?? true);
    },
  };
  return { tg, shown };
}

/** The browser's confirm(), answering `answer` and recording what it asked. */
function browser(answer: boolean) {
  const asked: string[] = [];
  return {
    asked,
    confirm: (message: string) => {
      asked.push(message);
      return answer;
    },
  };
}

const EN = 'Remove Alice from Store A?\n\nTheir roles and store permissions here are revoked.';
const ZH = '将 Alice 从 门店A 移除？\n\n她在这家门店的角色和权限设置都会撤销，其他门店不受影响。';

describe('confirmIn', () => {
  test('outside Telegram, the browser asks', async () => {
    const b = browser(true);
    expect(await confirmIn(null, EN, b.confirm)).toBe(true);
    expect(b.asked).toEqual([EN]);
  });

  test('in Telegram, the popup asks, with the paragraphs kept', async () => {
    const { tg, shown } = client({ answer: false });
    const b = browser(true);
    expect(await confirmIn(tg, EN, b.confirm)).toBe(false);
    expect(shown).toEqual([EN]);
    expect(b.asked).toEqual([]);
  });

  test('a second tap while the popup is open answers no, and asks nothing', async () => {
    const { tg } = client({ error: 'WebAppPopupOpened' });
    const b = browser(true);
    expect(await confirmIn(tg, EN, b.confirm)).toBe(false);
    expect(b.asked).toEqual([]);
  });

  test('a client too old for the popup falls back to the browser', async () => {
    const { tg } = client({ error: 'WebAppMethodUnsupported' });
    const b = browser(true);
    expect(await confirmIn(tg, EN, b.confirm)).toBe(true);
    expect(b.asked).toEqual([EN]);
  });

  test('a message too long for the popup still asks its question', async () => {
    const { tg, shown } = client();
    const long = `Remove Alice from Store A?\n\n${'Their roles here are revoked. '.repeat(12)}`;
    expect(long.length).toBeGreaterThan(TELEGRAM_POPUP_MAX);
    expect(await confirmIn(tg, long, browser(false).confirm)).toBe(true);
    expect(shown).toEqual(['Remove Alice from Store A?']);
  });
});

describe('popupText', () => {
  test('a single paragraph past the limit is cut with an ellipsis', () => {
    const text = popupText(`Remove ${'A'.repeat(300)}?`, false);
    expect(text).toHaveLength(TELEGRAM_POPUP_MAX);
    expect(text.endsWith('…')).toBe(true);
  });

  test('the cut never splits an emoji in half', () => {
    // 254 letters, then emoji: the cut at 255 code units falls inside one.
    const text = popupText(`${'a'.repeat(254)}${'😀'.repeat(10)}`, false);
    expect(text).toBe(`${'a'.repeat(254)}…`);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_POPUP_MAX);
  });

  test('only iOS gets the flattened message', () => {
    expect(popupText(EN, false)).toBe(EN);
    expect(popupText(EN, true)).toBe(
      'Remove Alice from Store A? Their roles and store permissions here are revoked.',
    );
  });
});

describe('flattenParagraphs', () => {
  test('a Chinese stop is the break itself: no dash, no space', () => {
    expect(flattenParagraphs(ZH)).toBe(
      '将 Alice 从 门店A 移除？她在这家门店的角色和权限设置都会撤销，其他门店不受影响。',
    );
  });

  test('Russian and Uzbek sentences get a space', () => {
    expect(flattenParagraphs('Убрать Alice?\n\nРоли будут сняты.')).toBe(
      'Убрать Alice? Роли будут сняты.',
    );
    expect(flattenParagraphs('Olib tashlansinmi?\n\nRuxsatlar qaytarib olinadi.')).toBe(
      'Olib tashlansinmi? Ruxsatlar qaytarib olinadi.',
    );
  });

  test('a paragraph without a stop keeps a visible break', () => {
    expect(flattenParagraphs('Not bought\n\nonion, salt')).toBe('Not bought — onion, salt');
    expect(flattenParagraphs('one line\nnext line')).toBe('one line next line');
  });
});
