import { cn } from '../cn';

export interface NavItem<K extends string = string> {
  key: K;
  label: string;
  /** Things waiting for this person on that screen. Zero shows nothing. */
  count?: number;
}

export interface BottomNavProps<K extends string = string> {
  items: Array<NavItem<K>>;
  active: K;
  onSelect: (key: K) => void;
  /** For screen readers: what this set of links is. */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * The app's sections, in words. No icons: the label is the control, and
 * a glyph above it would be a second, smaller thing to decode. The
 * current section is green and heavier; nothing is filled in.
 */
export function BottomNav<K extends string>({
  items,
  active,
  onSelect,
  label,
  disabled,
  className,
}: BottomNavProps<K>) {
  return (
    <nav
      aria-label={label}
      data-testid="primary-nav"
      className={cn('shrink-0 bg-neutral px-page pt-sm', className)}
      // The lit item is a filled shape, so it needs air under it as well.
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 8px)' }}
    >
      {/* A floating bar: its own rounded shape, clear of the screen's edges. */}
      <div className="flex gap-xs rounded-pill bg-surface p-xs">
        {items.map((item) => {
          const current = item.key === active;
          return (
            <button
              key={item.key}
              type="button"
              data-testid={`nav-${item.key}`}
              aria-current={current ? 'page' : undefined}
              disabled={disabled}
              onClick={() => onSelect(item.key)}
              className={cn(
                'flex h-tap min-w-0 flex-1 items-center justify-center gap-xs rounded-pill px-xs text-caption outline-none',
                'focus-visible:bg-surface-sunken',
                current ? 'bg-surface-sunken text-ink' : 'text-secondary',
              )}
            >
              <span className="min-w-0 truncate">{item.label}</span>
              {item.count ? (
                <span className="shrink-0 rounded-pill bg-primary px-sm text-on-primary">
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
