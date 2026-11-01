/**
 * Telegram URL helpers (M1.5, 2026-05-06).
 *
 * Centralizes the t.me/* URL templating that was previously inlined
 * in AdminPage.tsx's invite hub. Keeps the host as a single constant
 * so we can swap to a private domain later without hunting through
 * the codebase.
 */

const T_ME = 'https://t.me';

/** Direct link to a bot's start page. Pass the username WITHOUT the @. */
export function botLink(botUsername: string | null | undefined): string {
  if (!botUsername) return `${T_ME}/`;
  return `${T_ME}/${botUsername.replace(/^@/, '')}`;
}

/**
 * Deep link that opens the bot's Mini App with the invite token as
 * `start_param`. The bot never sees the token, so copying or sharing
 * the link does not need a round-trip through the bot first.
 */
export function inviteLink(botUsername: string | null | undefined, token: string): string | null {
  const username = botUsername?.replace(/^@/, '');
  if (!username || !token) return null;
  return `${T_ME}/${username}?startapp=${encodeURIComponent(token)}`;
}

/**
 * Telegram's native share-URL endpoint. Opening this URL inside
 * Telegram triggers the contact picker pre-filled with `url` + `text`.
 */
export function shareLink(args: { url: string; text: string }): string {
  return (
    `${T_ME}/share/url?url=${encodeURIComponent(args.url)}` +
    `&text=${encodeURIComponent(args.text)}`
  );
}

/** Direct link to a user by username (without @). */
export function userLink(username: string | null | undefined): string {
  if (!username) return `${T_ME}/`;
  return `${T_ME}/${username.replace(/^@/, '')}`;
}

/**
 * DX-BUY-4 (2026-11-01): how 「发送」 hands a list over. Inside Telegram,
 * Telegram's share picker. Outside it the SDK object still exists (it is
 * loaded in every browser), and `openTelegramLink` navigated the whole app
 * away to t.me; there the system share sheet is used when the browser has
 * one, otherwise the list is only copied.
 */
export type ShareRoute = 'telegram' | 'system' | 'copy';

export function shareRoute(inTelegram: boolean, hasSystemShare: boolean): ShareRoute {
  if (inTelegram) return 'telegram';
  return hasSystemShare ? 'system' : 'copy';
}
