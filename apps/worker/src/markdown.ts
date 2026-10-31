/**
 * Escaping for Telegram's MarkdownV2 (https://core.telegram.org/bots/api#markdownv2-style).
 *
 * Every reserved character gets a backslash, the backslash itself
 * included (security scan F6, 2026-10-31). Before, a reason typed as
 * `see \*note` came out as an escaped backslash followed by a live `*`:
 * the member who wrote it chose the formatting, or Telegram refused the
 * whole message ("can't parse entities") and the relay, treating that
 * 400 as permanent, dropped the push.
 */
export function escapeMd(text: string): string {
  return text.replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}
