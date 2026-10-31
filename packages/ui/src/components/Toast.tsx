import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { cn } from '../cn.js';

export type ToastTone = 'info' | 'success' | 'warn' | 'danger';

/**
 * 2026-10-21 FE-05: an explicit button inside the toast. A toast with
 * actions is NOT itself tappable — only its buttons are — so a sticky
 * prompt (e.g. "new version → reload") can't be hit by a stray tap meant
 * for the page underneath. Every action dismisses the toast after running.
 */
export interface ToastAction {
  label: ReactNode;
  onClick?: () => void;
  /** 'primary' = filled; default 'secondary'. */
  emphasis?: 'primary' | 'secondary';
}

interface ToastConfig {
  id: string;
  tone: ToastTone;
  title?: ReactNode;
  message: ReactNode;
  ttlMs?: number;
  onClick?: () => void;
  actions?: ToastAction[];
}

interface ToastContextValue {
  show: (
    message: ReactNode,
    opts?: {
      tone?: ToastTone;
      title?: ReactNode;
      /** 0 keeps the toast up until it is tapped or dismissed. */
      ttlMs?: number;
      /** Runs when the toast is tapped, before it is dismissed.
       *  Ignored when `actions` is given. */
      onClick?: () => void;
      /** Explicit buttons; the toast body then stops being a tap target. */
      actions?: ToastAction[];
    },
  ) => string;
  success: (message: ReactNode, title?: ReactNode) => string;
  error: (message: ReactNode, title?: ReactNode) => string;
  info: (message: ReactNode, title?: ReactNode) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE: Record<ToastTone, string> = {
  info: 'bg-[var(--c-surface-elevated)] text-[var(--c-fg)] ring-hairline',
  success:
    'bg-[var(--c-success-bg)] text-[var(--c-success-ink)] ring-1 ring-[var(--c-success)]',
  warn: 'bg-[var(--c-warn-bg)] text-[var(--c-warn-ink)] ring-1 ring-[var(--c-warning)]',
  danger:
    'bg-[var(--c-danger-bg)] text-[var(--c-danger-ink)] ring-1 ring-[var(--c-danger)]',
};

/**
 * U11 (2026-10-31): where toasts go while a sheet is open. They sat above
 * the page's main button at z-index 100, so a toast fired just before a
 * confirm sheet opened ("采购已记录", then 开始配送) landed on the sheet's
 * title. Returns the toast stack's distance from the viewport bottom (px):
 * just above the sheet when the space above it holds the stack, otherwise
 * (a tall sheet) just above its footer — over the sheet's body, never its
 * header. Exported for tests.
 */
export function toastOffsetForSheet(r: {
  viewportH: number;
  sheetTop: number;
  /** Top edge of the sheet's footer, or null when it has none. */
  footerTop: number | null;
  /** Space the top chrome takes (Telegram's buttons, safe area). */
  safeTop: number;
  /** Height the toast stack needs, gap included. */
  stackH: number;
}): number {
  const gap = 8;
  if (r.sheetTop - r.safeTop >= r.stackH + gap) return r.viewportH - r.sheetTop + gap;
  return r.viewportH - (r.footerTop ?? r.viewportH) + gap;
}

function cssPx(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

let counter = 0;
const nextId = () => `toast-${++counter}-${Math.random().toString(36).slice(2, 6)}`;

interface ToastProviderProps {
  children: ReactNode;
  /** Default time-to-live in ms. Per-toast override via `ttlMs`. */
  defaultTtlMs?: number;
  /** Maximum simultaneously visible. Older drop off the top. */
  limit?: number;
}

export function ToastProvider({
  children,
  defaultTtlMs = 4000,
  limit = 4,
}: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastConfig[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const stackRef = useRef<HTMLDivElement | null>(null);
  // U11: px from the viewport bottom while a sheet is open; null = the
  // usual place above the main button.
  const [sheetOffset, setSheetOffset] = useState<number | null>(null);
  const hasToasts = toasts.length > 0;
  useEffect(() => {
    if (!hasToasts || typeof window === 'undefined') {
      setSheetOffset(null);
      return;
    }
    // Followed every frame while toasts are up: a sheet slides in, grows
    // with its content and moves with the keyboard.
    let frame = 0;
    const follow = () => {
      const sheets = document.querySelectorAll<HTMLElement>(
        '[data-sheet-content][data-state="open"]',
      );
      const sheet = sheets[sheets.length - 1];
      let next: number | null = null;
      if (sheet) {
        const footer = sheet.querySelector<HTMLElement>('[data-sheet-footer]');
        next = Math.round(
          toastOffsetForSheet({
            viewportH: window.innerHeight,
            sheetTop: sheet.getBoundingClientRect().top,
            footerTop: footer ? footer.getBoundingClientRect().top : null,
            safeTop: cssPx('--app-safe-top'),
            stackH: stackRef.current?.offsetHeight ?? 48,
          }),
        );
      }
      setSheetOffset((cur) => (cur === next ? cur : next));
      frame = window.requestAnimationFrame(follow);
    };
    follow();
    return () => window.cancelAnimationFrame(frame);
  }, [hasToasts]);

  const dismiss = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const show = useCallback<ToastContextValue['show']>(
    (message, opts = {}) => {
      const id = nextId();
      const config: ToastConfig = {
        id,
        tone: opts.tone ?? 'info',
        title: opts.title,
        message,
        ttlMs: opts.ttlMs ?? defaultTtlMs,
        onClick: opts.onClick,
        actions: opts.actions?.length ? opts.actions : undefined,
      };
      setToasts((prev) => {
        // R2-INT-5 (2026-10-31): a success means the last attempt worked;
        // the error toast from the attempt before it no longer applies
        // (it used to stay on screen next to "Saved").
        const kept =
          config.tone === 'success'
            ? prev.filter((t) => {
                const stale = t.tone === 'danger' && !t.actions;
                if (stale) {
                  const timer = timersRef.current.get(t.id);
                  if (timer) clearTimeout(timer);
                  timersRef.current.delete(t.id);
                }
                return !stale;
              })
            : prev;
        const next = [...kept, config];
        // Over the limit, the oldest timed toast goes first: one that was
        // asked to stay must not be pushed out by passing notices.
        while (next.length > limit) {
          const drop = next.findIndex((t) => t.ttlMs && t.ttlMs > 0);
          next.splice(drop === -1 ? 0 : drop, 1);
        }
        return next;
      });
      const ttl = config.ttlMs;
      if (ttl && ttl > 0) {
        const handle = setTimeout(() => dismiss(id), ttl);
        timersRef.current.set(id, handle);
      }
      return id;
    },
    [defaultTtlMs, limit, dismiss],
  );

  useEffect(() => {
    const map = timersRef.current;
    return () => {
      for (const [, h] of map) clearTimeout(h);
      map.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      success: (message, title) => show(message, { tone: 'success', title }),
      error: (message, title) => show(message, { tone: 'danger', title }),
      info: (message, title) => show(message, { tone: 'info', title }),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        ref={stackRef}
        aria-live="polite"
        aria-atomic="true"
        data-toast-stack=""
        style={{
          // BOTTOM-anchored: Telegram's top chrome (Close + ⋯ + ⋄)
          // overlays ~60-80 px and isn't reported via env(safe-area-inset-top),
          // so a top-anchored toast got cropped. Anchoring at the bottom
          // also matches iOS toast convention.
          position: 'fixed',
          // 2026-10-21 FE-05: + the in-page main button's height (published
          // by the host Shell as --app-main-btn-h, 0 when none) so toasts
          // stack ABOVE "Submit / Save" instead of on top of it.
          bottom:
            sheetOffset !== null
              ? `${sheetOffset}px`
              : 'calc(var(--app-safe-bottom, 0px) + var(--app-nav-h, 64px) + var(--app-main-btn-h, 0px) + 12px)',
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column-reverse',
          alignItems: 'center',
          gap: 8,
          pointerEvents: 'none',
          zIndex: 100,
          paddingLeft: 'max(12px, var(--app-safe-left, 0px))',
          paddingRight: 'max(12px, var(--app-safe-right, 0px))',
        }}
      >
        {toasts.map((t) =>
          t.actions ? (
            <div
              key={t.id}
              role="status"
              className={cn(
                'flex min-w-[200px] max-w-[92vw] items-center gap-3 rounded-[var(--r-card)] px-4 py-2.5 text-left',
                TONE[t.tone],
              )}
              style={{ pointerEvents: 'auto' }}
            >
              <div className="min-w-0 flex-1">
                {t.title ? (
                  <div className="text-old-body-sm font-semibold leading-tight">{t.title}</div>
                ) : null}
                {t.message ? (
                  <div className="text-old-body-sm leading-snug">{t.message}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {t.actions.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      a.onClick?.();
                      dismiss(t.id);
                    }}
                    className={cn(
                      'press h-8 rounded-[var(--r-pill)] px-3 text-old-label font-semibold',
                      a.emphasis === 'primary'
                        ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                        : 'bg-[var(--c-surface-2)] text-[var(--c-fg)] ring-hairline',
                    )}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                t.onClick?.();
                dismiss(t.id);
              }}
              className={cn(
                'press min-w-[200px] max-w-[92vw] rounded-[var(--r-pill)] px-4 py-2.5 text-left',
                TONE[t.tone],
              )}
              style={{ pointerEvents: 'auto' }}
            >
              {t.title ? (
                <div className="text-old-body-sm font-semibold leading-tight">{t.title}</div>
              ) : null}
              <div className="text-old-body-sm leading-snug">{t.message}</div>
            </button>
          ),
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback no-op so a missing provider doesn't crash a page that
    // otherwise renders fine; the warning helps catch the wiring miss.
    if (typeof window !== 'undefined' && !(window as { __toastWarned?: boolean }).__toastWarned) {
      // eslint-disable-next-line no-console
      console.warn('[ui] useToast() called outside <ToastProvider>; toasts will be no-ops.');
      (window as { __toastWarned?: boolean }).__toastWarned = true;
    }
    const noop = () => '';
    return {
      show: noop,
      success: noop,
      error: noop,
      info: noop,
      dismiss: () => {},
    };
  }
  return ctx;
}
