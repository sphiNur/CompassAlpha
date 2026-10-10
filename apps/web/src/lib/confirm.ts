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
 */
import { getTg, isInTelegram } from '../hooks/useTelegram';

export function confirmNative(message: string): Promise<boolean> {
  const tg = isInTelegram() ? getTg() : null;
  if (!tg) return Promise.resolve(window.confirm(message));
  // iOS Telegram renders "\n\n" literally instead of as a paragraph
  // break, so flatten the message for it.
  const oneLine = message.replace(/\s*\n\s*\n\s*/g, ' — ').replace(/\s*\n\s*/g, ' ');
  return new Promise((resolve) => tg.showConfirm(oneLine, resolve));
}

export function confirmThen(message: string, ok: () => void): void {
  void confirmNative(message).then((yes) => {
    if (yes) ok();
  });
}
