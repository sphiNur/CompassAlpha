/**
 * ADM1-15 (2026-11-11): WebKit (Telegram on iOS) accepts a clipboard
 * write only during the tap, and the invite link arrives after a server
 * round trip. copyText asks for the write at once and fills it in later.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { copyText } from '../clipboard';

type Item = { items: Record<string, Promise<Blob>> };

const calls = { write: [] as Item[][], writeText: [] as string[] };
const saved = {
  clipboard: Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard'),
  item: (globalThis as { ClipboardItem?: unknown }).ClipboardItem,
};

function stubClipboard(opts: { write?: 'ok' | 'refuse' | 'none'; writeText?: 'ok' | 'refuse' }) {
  calls.write = [];
  calls.writeText = [];
  const clipboard: Record<string, unknown> = {
    writeText: (value: string) => {
      calls.writeText.push(value);
      return opts.writeText === 'refuse'
        ? Promise.reject(new Error('NotAllowedError'))
        : Promise.resolve();
    },
  };
  if (opts.write && opts.write !== 'none') {
    clipboard.write = (items: Item[]) => {
      calls.write.push(items);
      return opts.write === 'refuse'
        ? Promise.reject(new Error('NotAllowedError'))
        : Promise.resolve();
    };
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    };
  } else {
    delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  }
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: clipboard,
    configurable: true,
  });
}

afterEach(() => {
  if (saved.clipboard) Object.defineProperty(globalThis.navigator, 'clipboard', saved.clipboard);
  else delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
  if (saved.item === undefined) delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
  else (globalThis as { ClipboardItem?: unknown }).ClipboardItem = saved.item;
});

/** A promise and the function that settles it. */
function later() {
  let resolve!: (value: string) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('copyText', () => {
  it('writes ready text as plain text', async () => {
    stubClipboard({ write: 'ok' });
    expect(await copyText('hello')).toBe(true);
    expect(calls.writeText).toEqual(['hello']);
    expect(calls.write).toHaveLength(0);
  });

  it('asks for the write before pending text arrives, then fills it in', async () => {
    stubClipboard({ write: 'ok' });
    const text = later();
    const copied = copyText(text.promise);
    // Still inside the tap: the write has been asked for already.
    expect(calls.write).toHaveLength(1);
    text.resolve('invite\nhttps://t.me/bot?start=x');
    expect(await copied).toBe(true);
    const blob = await calls.write[0]![0]!.items['text/plain']!;
    expect(await blob.text()).toBe('invite\nhttps://t.me/bot?start=x');
    expect(calls.writeText).toHaveLength(0);
  });

  it('a refused pending write falls back to a plain write of the text', async () => {
    stubClipboard({ write: 'refuse' });
    expect(await copyText(Promise.resolve('link'))).toBe(true);
    expect(calls.writeText).toEqual(['link']);
  });

  it('pending text without ClipboardItem: a plain write once it arrives', async () => {
    stubClipboard({ write: 'none' });
    expect(await copyText(Promise.resolve('link'))).toBe(true);
    expect(calls.writeText).toEqual(['link']);
  });

  it('a clipboard that refuses everything: false, not an error', async () => {
    stubClipboard({ write: 'refuse', writeText: 'refuse' });
    expect(await copyText(Promise.resolve('link'))).toBe(false);
    stubClipboard({ writeText: 'refuse' });
    expect(await copyText('link')).toBe(false);
  });

  it('text that fails rejects with its own error and writes nothing', async () => {
    stubClipboard({ write: 'ok' });
    const text = later();
    const copied = copyText(text.promise);
    text.reject(new Error('people.inviteNoBot'));
    await expect(copied).rejects.toThrow('people.inviteNoBot');
    expect(calls.writeText).toHaveLength(0);
  });

  it('no clipboard and no document: false', async () => {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    expect(await copyText('link')).toBe(false);
  });
});
