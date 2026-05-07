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
