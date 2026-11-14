import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';

/**
 * Review MWA-03 / MWA-06 (modern-web-guidance: accessible-error-announcement):
 * the kit's way to speak through the host's one polite status region.
 *
 * A field error used to be its own `role="alert"` region, and a Button
 * hint its own `role="status"` region, each mounted already holding its
 * text. "A live region that is shown, rather than changed, isn't
 * announced reliably", and several of them on one sheet talked over each
 * other. The lines are plain text now, tied to their control with
 * aria-describedby; what has to be said goes to the host's region
 * (apps/web: `announce()` and Shell's LiveAnnouncer).
 *
 * `@compass/ui` must not import the host, so the host hands the function
 * in once at its root. Without a provider nothing is said, as before a
 * host adopts it.
 */
export type UiAnnounce = (message: string) => void;

const noop: UiAnnounce = () => {};

const UiAnnounceContext = createContext<UiAnnounce>(noop);

export function UiAnnouncerProvider({
  announce,
  children,
}: {
  announce: UiAnnounce;
  children: ReactNode;
}) {
  return <UiAnnounceContext.Provider value={announce}>{children}</UiAnnounceContext.Provider>;
}

/** The host's polite announcer, or a no-op outside one. */
export function useUiAnnounce(): UiAnnounce {
  return useContext(UiAnnounceContext);
}

/**
 * How long a message waits before it is said: "a moment later so it
 * doesn't talk over the next field" the person tabbed or tapped into.
 */
export const ANNOUNCE_DELAY_MS = 600;

/**
 * Says `text` once it has stood for {@link ANNOUNCE_DELAY_MS}: when it
 * appears, and again whenever it changes. Gone (null or empty) before
 * then, nothing is said.
 */
export function useAnnounceShown(text: string | null | undefined): void {
  const announce = useUiAnnounce();
  useEffect(() => {
    const said = text?.trim();
    if (!said) return;
    const timer = setTimeout(() => announce(said), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, announce]);
}

/** The part of a DOM node `spokenText` reads; a plain object in tests. */
export interface SpokenNode {
  nodeType: number;
  textContent: string | null;
  childNodes?: ArrayLike<SpokenNode>;
  getAttribute?(name: string): string | null;
}

/**
 * The text of a node as a screen reader reads it: what sits under
 * `aria-hidden="true"` (the "*" of a required label, a drawn sign) is
 * left out, and runs of white space become one space.
 */
export function spokenText(node: SpokenNode | null | undefined): string {
  const walk = (n: SpokenNode): string => {
    if (n.nodeType === 3) return n.textContent ?? '';
    if (n.nodeType !== 1) return '';
    if (n.getAttribute?.('aria-hidden') === 'true') return '';
    const kids = n.childNodes ? Array.from(n.childNodes) : [];
    return kids.map(walk).join('');
  };
  return node ? walk(node).replace(/\s+/g, ' ').trim() : '';
}
