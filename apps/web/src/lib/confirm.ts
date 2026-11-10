/**
 * One confirmation prompt for the whole app.
 *
 * Inside Telegram it is the client's native sheet. Everywhere else it is
 * the browser's own `confirm()`, which automation can answer.
 *
 * The check must be `isInTelegram()`, not "is the SDK object there":
 * index.html loads telegram-web-app.js in every browser, so the object
 * always exists, and `showConfirm` on it outside a real client is
 * unsupported.
 *
 * Telegram's popup throws, synchronously, on a message longer than 256
 * characters, on a second popup while one is open, and on clients older
 * than Bot API 6.2. That used to reject the promise: the action silently
 * did nothing, with an unhandled rejection (review COREWEB2-16). Now:
 * - a message too long for the popup keeps its first paragraph, the
 *   question, and is cut with "…" only if even that is too long;
 * - a second tap while the popup is open answers "no", and the open
 *   popup still decides;
 * - an old client gets the browser's `confirm()`.
 */
import { getTg, isInTelegram } from '../hooks/useTelegram';

/** The longest message Telegram's popup takes, counted after trimming. */
export const TELEGRAM_POPUP_MAX = 256;

/** What a confirmation needs from Telegram's WebApp object. */
export interface ConfirmHost {
  platform?: string;
  showConfirm(message: string, cb: (ok: boolean) => void): void;
}

export function confirmNative(message: string): Promise<boolean> {
  return confirmIn(isInTelegram() ? getTg() : null, message);
}

export function confirmThen(message: string, ok: () => void): void {
  void confirmNative(message).then((yes) => {
    if (yes) ok();
  });
}

/** `confirmNative` with its surroundings passed in, for the tests. */
export function confirmIn(
  tg: ConfirmHost | null,
  message: string,
  browserConfirm: (message: string) => boolean = (m) => window.confirm(m),
): Promise<boolean> {
  if (!tg) return Promise.resolve(browserConfirm(message));
  const text = popupText(message, tg.platform === 'ios');
  return new Promise((resolve) => {
    try {
      tg.showConfirm(text, resolve);
    } catch (err) {
      if (err instanceof Error && err.message === 'WebAppPopupOpened') resolve(false);
      else resolve(browserConfirm(message));
    }
  });
}

/** The message as Telegram's popup will take it. */
export function popupText(message: string, ios: boolean): string {
  // iOS Telegram renders "\n\n" literally instead of as a paragraph break,
  // so the message is flattened there; the other clients show it as is.
  const shape = (m: string) => (ios ? flattenParagraphs(m) : m.trim());
  let text = shape(message);
  if (text.length > TELEGRAM_POPUP_MAX) text = shape(message.trim().split(/\n\s*\n/)[0]!);
  if (text.length <= TELEGRAM_POPUP_MAX) return text;
  let cut = text.slice(0, TELEGRAM_POPUP_MAX - 1);
  // Never leave half of a character that takes two code units (an emoji).
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * Paragraphs joined into one line that reads right in every language:
 * nothing after a Chinese stop, which is the break itself; a space after
 * any other sentence end; a dash where a paragraph ends without one.
 */
export function flattenParagraphs(message: string): string {
  return message
    .trim()
    .replace(/([。？！；：])\s*\n\s*/g, '$1')
    .replace(/([.?!:;…])\s*\n\s*/g, '$1 ')
    .replace(/\s*\n\s*\n\s*/g, ' — ')
    .replace(/\s*\n\s*/g, ' ');
}
