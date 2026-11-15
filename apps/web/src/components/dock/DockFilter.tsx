/**
 * A page's view switch as a dock button (UI overhaul D, 2026-11-15,
 * owner): a circle on the nav's row with the count that needs attention
 * as its badge; a tap opens a sheet of the views, each with its count.
 * Drawn into the dock through a portal (lib/dockSlot.ts).
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { IconFilter, PickerGroup, PickerRow, Sheet, hapticSelection } from '@compass/ui';
import { useDockToolSlot } from '../../lib/dockSlot';
import { useI18n } from '../../hooks/useI18n';
import { NAV_BADGE_COUNT_CLASS, navBadgeCountText } from '../../lib/navBadgeLook';

export interface DockFilterOption<V extends string> {
  value: V;
  label: string;
  /** Shown beside the label when known. */
  count?: number;
}

export function DockFilter<V extends string>({
  label,
  value,
  options,
  onChange,
  badge,
}: {
  /** What is being chosen ("Approval status filter"): the button's and the sheet's name. */
  label: string;
  value: V;
  options: ReadonlyArray<DockFilterOption<V>>;
  onChange: (value: V) => void;
  /** A count on the circle (orders waiting), hidden at 0. */
  badge?: number;
}) {
  const slot = useDockToolSlot();
  const i18n = useI18n();
  const [open, setOpen] = useState(false);
  if (!slot) return null;
  const current = options.find((o) => o.value === value);
  const showBadge = typeof badge === 'number' && badge > 0;
  return (
    <>
      {createPortal(
        <div className="app-dock-tool">
          <button
            type="button"
            className="press app-dock-tool-btn"
            // MWG review (2026-11-15): the badge is aria-hidden, so the
            // waiting count is read with the name, as BottomNav does.
            aria-label={
              showBadge
                ? i18n.t('nav.badge.count', {
                    label: current ? `${label}: ${current.label}` : label,
                    n: badge,
                  })
                : current
                  ? `${label}: ${current.label}`
                  : label
            }
            title={label}
            aria-haspopup="dialog"
            data-testid="dock-filter"
            onClick={() => {
              hapticSelection();
              setOpen(true);
            }}
          >
            <IconFilter size={22} />
            {showBadge ? (
              <span aria-hidden className={`absolute -right-0.5 -top-0.5 ${NAV_BADGE_COUNT_CLASS}`}>
                {navBadgeCountText(badge)}
              </span>
            ) : null}
          </button>
        </div>,
        slot,
      )}
      <Sheet open={open} onOpenChange={setOpen} title={label}>
        <PickerGroup label={label}>
          {options.map((o) => (
            <PickerRow
              key={o.value}
              label={o.label}
              hint={typeof o.count === 'number' ? String(o.count) : undefined}
              selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            />
          ))}
        </PickerGroup>
      </Sheet>
    </>
  );
}
