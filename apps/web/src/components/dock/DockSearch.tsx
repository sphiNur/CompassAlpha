/**
 * The page's search as a dock button (UI overhaul C, 2026-11-15, owner):
 * a circle on the nav's row; a tap opens a search field across the row
 * (the nav steps aside, the main button stays), and Close folds it back.
 * The query stays while folded, and a dot on the circle says a search is
 * on. Drawn into the dock through a portal (lib/dockSlot.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconSearch, SearchInput, hapticSelection } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { useDockToolSlot } from '../../lib/dockSlot';

export function DockSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const i18n = useI18n();
  const slot = useDockToolSlot();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const reopenFocus = useRef(false);
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (reopenFocus.current) {
      reopenFocus.current = false;
      openerRef.current?.focus();
    }
  }, [open]);
  if (!slot) return null;
  const close = () => {
    reopenFocus.current = true;
    setOpen(false);
  };
  return createPortal(
    <div className="app-dock-tool" data-dock-search="" data-open={open ? '' : undefined}>
      {open ? (
        // MWG review (2026-11-15): Escape closes from the clear and close
        // buttons too, not only from the field.
        <div
          className="app-dock-search"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        >
          <SearchInput
            ref={inputRef}
            className="min-w-0 flex-1"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onClear={() => onChange('')}
            placeholder={placeholder}
            clearAriaLabel={i18n.t('common.clear')}
            aria-label={placeholder}
          />
          <button
            type="button"
            className="press app-dock-search-close"
            onClick={close}
            aria-label={i18n.t('dock.search.close')}
            title={i18n.t('dock.search.close')}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
      ) : (
        <button
          ref={openerRef}
          type="button"
          className="press app-dock-tool-btn"
          aria-label={value ? `${i18n.t('dock.search.open')}: ${value}` : i18n.t('dock.search.open')}
          title={i18n.t('dock.search.open')}
          data-testid="dock-search"
          onClick={() => {
            hapticSelection();
            setOpen(true);
          }}
        >
          <IconSearch size={22} />
          {value ? <span aria-hidden className="app-dock-tool-dot" /> : null}
        </button>
      )}
    </div>,
    slot,
  );
}
