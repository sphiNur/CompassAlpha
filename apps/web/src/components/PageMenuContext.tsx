/**
 * PageMenuContext (M1.12, 2026-05-08).
 *
 * Lets each page register a small list of "uncommon actions" that live
 * in Telegram's gear (⚙️ in the bot's ⋯ overflow menu) instead of
 * cluttering the body.
 *
 * Why this exists: the user asked us to lift per-page chrome out of
 * the body and into Telegram's native chrome row. Telegram's only
 * controllable native slots are BackButton (left) and SettingsButton
 * (gear, in the ⋯ overflow). The bot name in the center is fixed by
 * Telegram. So we use the gear as our "page actions" home and have
 * Shell's <SettingsSheet> render them at the top, above the global
 * Profile / Language / About sections.
 *
 * UX-09 (2026-11-14): people rarely found the gear, so the top bar's ⋮
 * button (app/shell/TopBar.tsx) opens the same sheet too.
 *
 * Pages call `usePageMenu([...])` once per render; the unmount cleanup
 * clears the registration so navigating away doesn't strand stale
 * actions in the sheet.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface PageMenuAction {
  /** Visible label inside the sheet button. */
  label: string;
  /** Click handler. The sheet auto-closes before invoking. */
  onClick: () => void;
  /** Visual variant. `danger` paints red for destructive actions. */
  variant?: 'pearl' | 'danger';
  /** Optional one-line hint shown under the label. */
  hint?: string;
  /** If false, action is rendered grayed out and the click is ignored. */
  disabled?: boolean;
}

export interface PageMenuRegistration {
  /** Section title above the action list (e.g. "Run #3"). */
  title: string;
  actions: PageMenuAction[];
}

interface PageMenuContextValue {
  registration: PageMenuRegistration | null;
  setRegistration: (r: PageMenuRegistration | null) => void;
}

const PageMenuContext = createContext<PageMenuContextValue | null>(null);

export function PageMenuProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<PageMenuRegistration | null>(null);
  const value = useMemo(() => ({ registration, setRegistration }), [registration]);
  return <PageMenuContext.Provider value={value}>{children}</PageMenuContext.Provider>;
}

/** Read-only access for the host (Shell) so it can render the sheet. */
export function usePageMenuRegistration(): PageMenuRegistration | null {
  const ctx = useContext(PageMenuContext);
  return ctx?.registration ?? null;
}

/**
 * Register the current page's overflow actions. Pass `null` (or skip
 * the call) to render no contextual section.
 *
 * The hook holds the latest registration in a ref so re-renders that
 * change action handlers (e.g., closures over fresh state) don't churn
 * the context. Only structural changes (title, label list, variant
 * mix) write through; a click runs the handler of the latest render.
 */
export function usePageMenu(registration: PageMenuRegistration | null): void {
  // Outside a provider there is no setter and the effect below is a
  // no-op, which lets pages be tested in isolation without a wrapper.
  // The setter is a state setter: the same function on every render.
  const setRegistration = useContext(PageMenuContext)?.setRegistration;
  // Stable identity: hash on title + label list + disabled bits +
  // variant mix. Click handlers are kept fresh via ref so consumers
  // don't have to memoise their own closures.
  const ref = useRef<PageMenuRegistration | null>(registration);
  ref.current = registration;
  const key =
    registration === null
      ? null
      : `${registration.title}::` +
        registration.actions
          .map(
            (a) => `${a.label}|${a.variant ?? 'pearl'}|${a.disabled ? 'd' : 'e'}|${a.hint ?? ''}`,
          )
          .join('||');

  useEffect(() => {
    if (!setRegistration) return;
    setRegistration(liveRegistration(ref.current, () => ref.current));
    return () => setRegistration(null);
  }, [key, setRegistration]);
}

/**
 * The registration as the sheet stores it: each action's click runs the
 * handler of the latest render (`latest`), not of the render that stored
 * it. Review COREWEB1-13 (2026-11-12): the stored actions were that
 * render's own closures, so a click ran with whatever state (a run id, an
 * expected seq) they had closed over when the label list last changed.
 */
export function liveRegistration(
  registration: PageMenuRegistration | null,
  latest: () => PageMenuRegistration | null,
): PageMenuRegistration | null {
  return (
    registration && {
      ...registration,
      actions: registration.actions.map((action, i) => ({
        ...action,
        onClick: () => latest()?.actions[i]?.onClick(),
      })),
    }
  );
}
