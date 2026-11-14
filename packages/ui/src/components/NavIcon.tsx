/**
 * Tab-bar icons — line-art SVG, 24x24, currentColor.
 *
 * Replaces emoji that previously sat in the bottom nav. Emoji look
 * playful on iOS but read as amateurish next to native iOS icons in
 * the rest of Telegram's UI; switching to monochrome line-art puts us
 * visually next to Telegram's own bottom-bar style (e.g. the chats /
 * contacts / settings tabs in the main Telegram app).
 *
 * Each icon is hand-pruned to ~stroke-width 1.75 for visual parity at
 * the 24 px native size; no external icon library so we don't ship
 * 200 KB of glyphs we won't use.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function svgBase({ size = 24, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export function IconOrder(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M16 4v3h3" />
      <path d="M9 11h6M9 14h6M9 17h4" />
    </svg>
  );
}

export function IconApprove(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5L15.5 10" />
    </svg>
  );
}

export function IconRun(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M3 5h2l2.5 11h11l2-7H7" />
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="17" cy="20" r="1.5" />
    </svg>
  );
}

export function IconConfirm(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M12 3 4 7v10l8 4 8-4V7z" />
      <path d="M4 7l8 4 8-4" />
      <path d="M12 11v10" />
    </svg>
  );
}

export function IconAdmin(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2" />
    </svg>
  );
}

export function IconWorkspace(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <rect x="4" y="6" width="16" height="14" rx="2" />
      <path d="M9 6V4h6v2" />
      <path d="M4 12h16" />
    </svg>
  );
}

export function IconPeople(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M14.5 16.5h.5a4 4 0 0 1 4 4v.5" />
    </svg>
  );
}

export function IconCatalog(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M4 5h12a3 3 0 0 1 3 3v12H7a3 3 0 0 1-3-3z" />
      <path d="M19 8H7a3 3 0 0 0-3 3" />
    </svg>
  );
}

/** Clock with a counter-clockwise arrow — the conventional "history"
 *  mark. Deliberately NOT a list/receipt glyph: IconCatalog and
 *  IconOrder already own that shape in the same bottom nav, and at
 *  24 px three list-like icons in a row are indistinguishable. */
export function IconHistory(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M3.5 9A9 9 0 1 1 3 12" />
      <path d="M3 4.5V9h4.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/** Attendance: a clock face with a check — clocking in, not history. */
export function IconAttendance(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12h3.5" />
      <path d="M15.5 17.5l1.8 1.8 3.2-3.6" />
    </svg>
  );
}

/**
 * Daily settlement / cash-register mark. The drawer + receipt notch make
 * the close-of-day destination distinct from the order sheet and history
 * clock already present in the primary navigation.
 */
export function IconSettlement(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M5 9h14v10H5z" />
      <path d="M7 9V5h10v4" />
      <path d="M8 13h8M9 16h2" />
      <path d="M17 16h.01" />
    </svg>
  );
}

/** The bottom nav's More item: the sections that do not fit the bar. */
export function IconMore(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </svg>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </svg>
  );
}

export function IconMaintenance(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M14.7 6.3a4 4 0 1 1-5 5l-6 6a2 2 0 0 0 2.8 2.8l6-6a4 4 0 0 1 5-5l-1.5 1.5a1 1 0 0 0 0 1.4l1 1a1 1 0 0 0 1.4 0z" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function IconShare(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M12 4v12" />
      <path d="m8 8 4-4 4 4" />
      <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

/**
 * IconShield — shield outline for permissions / roles / access surfaces.
 * Added 2026-05-08 (M1.11) so the AdminPage section list can stop reusing
 * IconWorkspace for both Organization and Permissions (visual ambiguity).
 */
export function IconShield(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M12 3 5 6v6c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

/**
 * IconMoreVertical: three dots stacked, "more". Added 2026-11-14 (UX-09)
 * for the top bar's way into settings inside Telegram. Vertical so it is
 * not mistaken for Telegram's own horizontal ⋯ pill next to it; not a
 * gear, which reads as the Admin tab (IconAdmin).
 */
export function IconMoreVertical(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <circle cx="12" cy="5.5" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="18.5" r="1" fill="currentColor" />
    </svg>
  );
}

/*
 * The page main button's actions (owner, 2026-11-14): on the nav's row the
 * button is a circle with an icon, its words its accessible name
 * (PageMainButton.tsx). Same line-art as the tabs. A cart is IconRun.
 */

/** Done / save / confirm: a plain check. */
export function IconCheck(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Send (an order): an arrow up, as a message is sent. */
export function IconSend(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  );
}

/** Delivery: a truck. */
export function IconTruck(props: IconProps) {
  return (
    <svg {...svgBase(props)}>
      <path d="M3 6h11v10H3z" />
      <path d="M14 9h4l3 3.5V16h-7" />
      <circle cx="7" cy="17.5" r="1.75" />
      <circle cx="17" cy="17.5" r="1.75" />
    </svg>
  );
}
