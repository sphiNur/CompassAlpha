/**
 * UX-07 (2026-11-14): the in-app yes/no question, without React.
 *
 * Every confirmation in the app used Telegram's native popup (or the
 * browser's `confirm()`): 256 characters, one line on iOS, and nothing
 * like the rest of the app. They now open the kit's ConfirmSheet through
 * one ConfirmProvider; this is the state behind it, kept apart so a test
 * can drive it without a DOM.
 *
 * One question at a time, as Telegram's popup had it: asking while a
 * question is open answers "no" at once, and the open question still
 * decides.
 */

/** What a confirmation says. Plain strings, so a host without the provider can fall back. */
export interface ConfirmRequest {
  /** The question. A blank line splits it: the first paragraph is the title, the rest the body. */
  title: string;
  /** More about what happens. Newlines are kept. */
  body?: string;
  /** The button that answers yes, named after the action ("Archive"). */
  confirmLabel: string;
  /** Red action; Cancel is shown and starts focused (ConfirmSheet's confirmCancelPolicy). */
  danger?: boolean;
}

/** Asks a question; resolves true on yes, false on no or dismiss. */
export type Confirm = (request: ConfirmRequest) => Promise<boolean>;

export interface ConfirmQueue {
  ask: Confirm;
  /** Answers the open question; nothing when none is open. */
  answer(ok: boolean): void;
  /** The open question, or null. */
  current(): ConfirmRequest | null;
  subscribe(listener: () => void): () => void;
}

export function createConfirmQueue(): ConfirmQueue {
  let open: { request: ConfirmRequest; resolve: (ok: boolean) => void } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    ask(request) {
      if (open) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        open = { request: splitQuestion(request), resolve };
        notify();
      });
    },
    answer(ok) {
      if (!open) return;
      const { resolve } = open;
      open = null;
      notify();
      resolve(ok);
    },
    current: () => open?.request ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * A one-string question (the catalogs' confirm messages were written for
 * a popup) shown as a sheet: its first paragraph is the title and what
 * follows a blank line is the body. Exported for tests.
 */
export function splitQuestion(request: ConfirmRequest): ConfirmRequest {
  if (request.body !== undefined) return request;
  const [first, ...rest] = request.title.trim().split(/\n\s*\n/);
  const body = rest.join('\n\n').trim();
  return body ? { ...request, title: first!.trim(), body } : { ...request, title: first!.trim() };
}

/**
 * Without a ConfirmProvider (a host or a test that mounts none): the
 * browser's own confirm, and yes where there is no window.
 */
export const browserConfirm: Confirm = (request) =>
  Promise.resolve(
    typeof window === 'undefined'
      ? true
      : window.confirm([request.title, request.body].filter(Boolean).join('\n\n')),
  );
