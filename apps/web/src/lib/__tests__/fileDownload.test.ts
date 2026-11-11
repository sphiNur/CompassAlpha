/**
 * Review TEST3-08 (2026-11-10): the attendance month export had no test of
 * how the file reaches the phone. Inside Telegram it goes through
 * Telegram's download dialog (Bot API 8.0), older clients open the link,
 * and a plain browser follows a download link.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { absoluteUrl, saveFile } from '../fileDownload';

const g = globalThis as { window?: unknown; document?: unknown };
const real = { window: g.window, document: g.document };

afterEach(() => {
  g.window = real.window;
  g.document = real.document;
});

const PATH = '/attendance/export?month=2026-11';
const FILE = 'attendance-2026-11.xlsx';

/** A page whose document records what a download link does. */
function page(telegram?: Partial<TelegramWebAppGlobal>): string[] {
  const log: string[] = [];
  g.window = {
    location: { origin: 'https://app.test' },
    Telegram: telegram && { WebApp: telegram },
  };
  g.document = {
    body: { appendChild: () => void log.push('append') },
    createElement(tag: string) {
      const el = {
        tag,
        href: '',
        download: '',
        rel: '',
        click: () => void log.push(`click ${el.tag} ${el.href} ${el.download} ${el.rel}`),
        remove: () => void log.push('remove'),
      };
      return el;
    },
  };
  return log;
}

/** Telegram with the download dialog, answering `ok`, or throwing. */
function telegram(answer: boolean | undefined | 'throws', modern = true) {
  const calls: string[] = [];
  const tg: Partial<TelegramWebAppGlobal> = {
    initData: 'query_id=1',
    isVersionAtLeast: () => modern,
    downloadFile(params, cb) {
      calls.push(`download ${params.url} ${params.file_name}`);
      if (answer === 'throws') throw new Error('WebAppMethodUnsupported');
      cb?.(answer as boolean);
    },
    openLink(url) {
      calls.push(`open ${url}`);
    },
  };
  return { tg, calls };
}

describe('absoluteUrl', () => {
  test('makes the server path absolute and keeps it', () => {
    page();
    const url = absoluteUrl(PATH);
    expect(new URL(url).href).toBe(url);
    expect(url.endsWith(PATH)).toBe(true);
  });
});

describe('saveFile', () => {
  test("inside Telegram the file goes through Telegram's download dialog", async () => {
    const { tg, calls } = telegram(true);
    const log = page(tg);
    expect(await saveFile(PATH, FILE)).toBe(true);
    expect(calls).toEqual([`download ${absoluteUrl(PATH)} ${FILE}`]);
    expect(log).toEqual([]);
  });

  test('cancelling the dialog resolves false; no answer counts as saved', async () => {
    page(telegram(false).tg);
    expect(await saveFile(PATH, FILE)).toBe(false);
    page(telegram(undefined).tg);
    expect(await saveFile(PATH, FILE)).toBe(true);
  });

  test('a dialog that throws opens the link instead', async () => {
    const { tg, calls } = telegram('throws');
    page(tg);
    expect(await saveFile(PATH, FILE)).toBe(true);
    expect(calls).toEqual([`download ${absoluteUrl(PATH)} ${FILE}`, `open ${absoluteUrl(PATH)}`]);
  });

  test("a Telegram client older than Bot API 8.0 opens the link in the phone's browser", async () => {
    const { tg, calls } = telegram(true, false);
    page(tg);
    expect(await saveFile(PATH, FILE)).toBe(true);
    expect(calls).toEqual([`open ${absoluteUrl(PATH)}`]);
  });

  test('a plain browser follows a download link, which is then removed', async () => {
    const log = page();
    expect(await saveFile(PATH, FILE)).toBe(true);
    expect(log).toEqual(['append', `click a ${absoluteUrl(PATH)} ${FILE} noopener`, 'remove']);
  });

  test('the Telegram script in a plain browser (no initData) is a plain browser', async () => {
    const { tg, calls } = telegram(true);
    const log = page({ ...tg, initData: '' });
    expect(await saveFile(PATH, FILE)).toBe(true);
    expect(calls).toEqual([]);
    expect(log).toHaveLength(3);
  });
});
