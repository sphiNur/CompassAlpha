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
import { useSheetCount } from './Sheet';
import { cn } from '../cn.js';

export type ToastTone = 'info' | 'success' | 'warn' | 'danger';

interface ToastConfig {
  id: string;
  tone: ToastTone;
  title?: ReactNode;
  message: ReactNode;
  ttlMs?: number;
  onClick?: () => void;
}

interface ToastContextValue {
  show: (
    message: ReactNode,
    opts?: {
      tone?: ToastTone;
      title?: ReactNode;
      /** 0 keeps the toast up until it is tapped or dismissed. */
      ttlMs?: number;
      /** Runs when the toast is tapped, before it is dismissed. */
      onClick?: () => void;
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
  success: 'bg-[oklch(96%_0.06_145)] text-[oklch(35%_0.16_145)] ring-1 ring-[var(--c-success)]',
  warn: 'bg-[oklch(97%_0.07_75)] text-[oklch(38%_0.16_75)] ring-1 ring-[var(--c-warning)]',
  danger: 'bg-[oklch(96%_0.06_25)] text-[var(--c-danger)] ring-1 ring-[var(--c-danger)]',
};

let counter = 0;
const nextId = () => `toast-${++counter}-${Math.random().toString(36).slice(2, 6)}`;

interface ToastProviderProps {
  children: ReactNode;
  /** Default time-to-live in ms. Per-toast override via `ttlMs`. */
  defaultTtlMs?: number;
  /** Maximum simultaneously visible. Older drop off the top. */
  limit?: number;
}

export function ToastProvider({ children, defaultTtlMs = 4000, limit = 4 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<ToastConfig[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

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
      };
      setToasts((prev) => {
        const next = [...prev, config];
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

  const sheetOpen = useSheetCount() > 0;

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          // Above the shell's pinned bottom (its action bar and
          // navigation, measured into `--app-bottom-chrome-h`), so a toast
          // never lands on the button a person is about to press. While
          // a sheet is open the buttons are the sheet's own, at the
          // bottom edge, so the toast moves to the top instead, below
          // whatever Telegram floats there.
          position: 'fixed',
          ...(sheetOpen
            ? { top: 'calc(var(--app-chrome-reserve, var(--app-safe-top, 0px)) + 8px)' }
            : {
                bottom:
                  'calc(var(--app-bottom-chrome-h, calc(var(--app-safe-bottom, 0px) + var(--app-nav-h, 64px))) + 12px)',
              }),
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
        {/* One at a time: the newest. A stack buries the screen it reports on. */}
        {toasts.slice(-1).map((t) => (
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
        ))}
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
