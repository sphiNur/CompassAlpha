import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '../cn';

/**
 * Tabs — a real tab control with roving tabindex + keyboard nav.
 *
 * Why this exists separately from ChipBar+Chip: ChipBar applies
 * role="tablist"/role="tab" semantics but has no roving tabindex,
 * no arrow-key nav, no Home/End. Five pages lean on ChipBar as their
 * tab control (Approval/Order/Run/Confirm/Debug); for keyboard or
 * screen-reader users the experience is "tab gets you in, then you're
 * stuck". This component fixes that.
 *
 * API mirrors Radix Tabs (Tabs / Tab) but ships zero dependencies —
 * we don't need the full Tabs.Content composition because every
 * caller renders the panel in their own conditional below the bar.
 *
 * Usage:
 *
 *   <Tabs value={tab} onChange={setTab} ariaLabel="…">
 *     <Tab value="pending">{i18n.t('…')}</Tab>
 *     <Tab value="approved">{i18n.t('…')}</Tab>
 *     <Tab value="rejected">{i18n.t('…')}</Tab>
 *   </Tabs>
 *
 * Behavior:
 *   - Tab key enters/exits the tablist; only the SELECTED tab is in
 *     the tab order. Inside the list, ArrowLeft / ArrowRight cycle
 *     (with wrap), Home jumps to first, End to last. Activating
 *     (Enter/Space) calls onChange — same as click.
 *   - role="tablist" / role="tab" / aria-selected / aria-controls
 *     follow WAI-ARIA APG.
 */

interface TabsProps {
  /** Currently-selected tab value. */
  value: string;
  /** Fires when the user picks a different tab (click or kbd). */
  onChange: (value: string) => void;
  /** Accessible label announced for the tablist. */
  ariaLabel: string;
  /**
   * `<Tab>` children. We deliberately don't accept arbitrary nodes —
   * the focus / keyboard machinery needs to know each child's value.
   */
  children: ReactNode;
  /** Extra classes on the outer scroll container. */
  className?: string;
}

interface TabProps {
  value: string;
  children: ReactNode;
  /** Per-tab override (rare — caller usually leaves default). */
  className?: string;
  /**
   * Internal — set by Tabs when cloning. Caller should NOT pass.
   */
  _selected?: boolean;
  _onSelect?: (value: string) => void;
  _onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
  _tabIndex?: number;
  _ref?: (el: HTMLButtonElement | null) => void;
  _id?: string;
}

export function Tab({
  value,
  children,
  className,
  _selected,
  _onSelect,
  _onKeyDown,
  _tabIndex,
  _ref,
  _id,
}: TabProps) {
  return (
    <button
      ref={_ref}
      type="button"
      role="tab"
      id={_id}
      aria-selected={_selected || undefined}
      tabIndex={_tabIndex}
      onClick={() => _onSelect?.(value)}
      onKeyDown={_onKeyDown}
      className={cn(
        'press inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[var(--r-pill)] px-4 text-body font-medium',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-ring)] focus-visible:ring-offset-2',
        'focus-visible:ring-offset-[var(--c-bg)]',
        _selected
          ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
          : 'bg-transparent text-[var(--c-fg-muted)] ring-hairline',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Tabs({ value, onChange, ariaLabel, children, className }: TabsProps) {
  const id = useId();
  const refsRef = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Collect every <Tab> child's value in source order so arrow-key
  // nav can cycle through them. Filtered to ReactElements that look
  // like Tab (have a `value` prop).
  const tabs = Children.toArray(children).filter(
    (c): c is ReactElement<TabProps> =>
      isValidElement(c) && typeof (c.props as TabProps).value === 'string',
  );
  const values = tabs.map((c) => c.props.value);

  const setRef = useCallback(
    (val: string) => (el: HTMLButtonElement | null) => {
      if (el) refsRef.current.set(val, el);
      else refsRef.current.delete(val);
    },
    [],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      const idx = values.indexOf(value);
      if (idx < 0) return;
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % values.length;
      else if (e.key === 'ArrowLeft')
        nextIdx = (idx - 1 + values.length) % values.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = values.length - 1;
      else return;
      e.preventDefault();
      const nextVal = values[nextIdx];
      if (typeof nextVal !== 'string') return;
      onChange(nextVal);
      // Focus the new tab so the user's caret follows their selection.
      const el = refsRef.current.get(nextVal);
      el?.focus();
    },
    [onChange, value, values],
  );

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{ overscrollBehaviorX: 'contain' }}
      className={cn('flex gap-2 overflow-x-auto px-4 py-2 scrollbar-hide', className)}
    >
      {tabs.map((child) =>
        cloneElement(child, {
          _selected: child.props.value === value,
          _onSelect: onChange,
          _onKeyDown: onKeyDown,
          _tabIndex: child.props.value === value ? 0 : -1,
          _ref: setRef(child.props.value),
          _id: `${id}-tab-${child.props.value}`,
        }),
      )}
    </div>
  );
}
