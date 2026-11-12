/**
 * What the worker does with one sync.outbox row, as pure functions
 * (COREAPI-03, 2026-11-09).
 *
 * The flush takes the oldest due row first. A row whose payload could not
 * be turned into a message (a missing title made `escapeMd` throw; a
 * recipient that is not a uuid made the user lookup fail) threw before
 * anything was written back, so the same row was taken again on every
 * pass and every notification behind it waited forever. A payload that
 * can never be sent is now recognised up front and closed with the
 * reason; an unexpected failure is retried with the usual backoff, like
 * a failed send.
 */
import { escapeMd } from './markdown';

export interface OutboxPayload {
  orgId: string;
  recipientUserId: string;
  template: string;
  title: string;
  body?: string;
  deepLink?: string;
  /**
   * The button's label in the recipient's language, written by the API's
   * dispatch (COREAPI-19, 2026-11-10). Rows queued before it have none.
   */
  buttonText?: string;
  dedupKey?: string;
  extra?: Record<string, unknown>;
}

/** The button's label when the payload carries none. */
export const DEFAULT_BUTTON_TEXT = 'Open Compass';

/** Tries after the first one before a row is given up. */
export const MAX_RETRIES = 8;
/**
 * The wait before each of those tries: 5 s, 10 s, 30 s, 1 min, 5 min,
 * 15 min, 1 h, 3 h.
 */
export const BACKOFF_SECONDS = [5, 10, 30, 60, 300, 900, 3600, 10_800] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why this payload can never be sent as a bot message; null when it can. */
export function outboxPayloadProblem(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'payload is not an object';
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.recipientUserId !== 'string' || !UUID.test(p.recipientUserId)) {
    return 'recipientUserId is not a uuid';
  }
  if (typeof p.title !== 'string' || p.title.trim() === '') return 'title is missing';
  if (p.body !== undefined && p.body !== null && typeof p.body !== 'string') {
    return 'body is not text';
  }
  if (p.deepLink !== undefined && p.deepLink !== null && typeof p.deepLink !== 'string') {
    return 'deepLink is not text';
  }
  return null;
}

/** The link behind the message's button. */
export function resolveDeepLink(path: string, frontendUrl: string | null | undefined): string {
  const base = frontendUrl?.replace(/\/$/, '') ?? '';
  if (path.startsWith('http')) return path;
  if (!base) return path;
  return base + (path.startsWith('/') ? path : '/' + path);
}

/**
 * The button's label. A label that is missing, blank or not text falls
 * back to the English one rather than holding the message back: the
 * button is still the way into the app.
 */
function buttonLabel(payload: OutboxPayload): string {
  const label = typeof payload.buttonText === 'string' ? payload.buttonText.trim() : '';
  return label || DEFAULT_BUTTON_TEXT;
}

/**
 * The Telegram message for a payload that passed `outboxPayloadProblem`.
 *
 * Review COREAPI-27 (2026-11-12): Telegram opens only an https address
 * from a button, and refuses the whole message (400) when the button has
 * another one. Without FRONTEND_URL the link stayed a bare path, and every
 * message with a button was given up as undeliverable. Such a message now
 * goes out without its button.
 */
export function botMessage(
  payload: OutboxPayload,
  frontendUrl: string | null | undefined,
): { text: string; opts: Record<string, unknown> } {
  const text = payload.body
    ? `*${escapeMd(payload.title)}*\n${escapeMd(payload.body)}`
    : `*${escapeMd(payload.title)}*`;
  const link = payload.deepLink ? resolveDeepLink(payload.deepLink, frontendUrl) : '';
  const opts: Record<string, unknown> = {
    parse_mode: 'MarkdownV2',
    ...(link.startsWith('https://')
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: buttonLabel(payload), web_app: { url: link } }]],
          },
        }
      : {}),
  };
  return { text, opts };
}

/**
 * After a failed try, with `retries` tries already made after the first:
 * when to try again, or give up.
 *
 * Review COREAPI-24 (2026-11-12): the wait was read one place on, so the
 * first retry came after 10 s and the 5 s wait was never used, and a row
 * was given up after seven retries while its error said eight.
 */
export function nextAttempt(
  retries: number,
): { giveUp: true } | { giveUp: false; retries: number; delaySeconds: number } {
  if (retries >= MAX_RETRIES) return { giveUp: true };
  return {
    giveUp: false,
    retries: retries + 1,
    delaySeconds: BACKOFF_SECONDS[Math.min(retries, BACKOFF_SECONDS.length - 1)]!,
  };
}
