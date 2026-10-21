/**
 * Telegram BackButton owner stack (2026-10-21 audit CA-34 / E-03, E-23).
 *
 * Telegram's WebApp BackButton is ONE global button whose `onClick`
 * APPENDS listeners. Before this, every sheet appended its own close
 * handler without ever calling `show()`, and `useTelegramBackButton`
 * called `hide()` on unmount — so an open sheet showed Telegram's "Close"
 * instead of a back arrow (Android's hardware back closed the whole Mini
 * App), and whichever registrant unmounted first hid the button for
 * everyone else.
 *
 * Now there is exactly one listener on the SDK button (`dispatch`), and it
 * calls only the most recent registrant. The button is visible while the
 * stack is non-empty; popping an entry (unmount / sheet close) restores the
 * previous owner. Entries are removed by identity, so out-of-order
 * unmounts are safe.
 *
 * Kept free of React and apps/web imports so both the Sheet in this
 * package and the app's hooks can share the one instance.
 */
export interface BackButtonLike {
  show(): void;
  hide(): void;
  onClick(cb: () => void): unknown;
  offClick(cb: () => void): unknown;
}

export interface BackHandlerStack {
  /** Register a handler on top; returns the function that removes it. */
  push(handler: () => void): () => void;
  size(): number;
}

export function createBackHandlerStack(
  getButton: () => BackButtonLike | null | undefined,
): BackHandlerStack {
  const stack: Array<{ handler: () => void }> = [];
  let wired: BackButtonLike | null = null;
  const dispatch = () => {
    stack[stack.length - 1]?.handler();
  };
  const sync = () => {
    const btn = getButton() ?? null;
    if (!btn) return;
    try {
      if (stack.length > 0) {
        if (wired !== btn) {
          wired?.offClick(dispatch);
          btn.onClick(dispatch);
          wired = btn;
        }
        btn.show();
      } else {
        if (wired) {
          wired.offClick(dispatch);
          wired = null;
        }
        btn.hide();
      }
    } catch {
      /* an SDK hiccup must never break a sheet or a page */
    }
  };
  return {
    push(handler) {
      const entry = { handler };
      stack.push(entry);
      sync();
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const i = stack.lastIndexOf(entry);
        if (i >= 0) stack.splice(i, 1);
        sync();
      };
    },
    size: () => stack.length,
  };
}

/** The app-wide instance bound to `window.Telegram.WebApp.BackButton`. */
export const telegramBackStack: BackHandlerStack = createBackHandlerStack(() =>
  typeof window !== 'undefined'
    ? (window as { Telegram?: { WebApp?: { BackButton?: BackButtonLike } } }).Telegram?.WebApp
        ?.BackButton
    : null,
);

export function pushTelegramBackHandler(handler: () => void): () => void {
  return telegramBackStack.push(handler);
}
