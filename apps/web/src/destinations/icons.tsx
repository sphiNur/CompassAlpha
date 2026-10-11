/**
 * The four navigation icons. Each sits above its word and never replaces
 * it. Drawn here, 24px on a 2px stroke, so there is no icon package to
 * load for four shapes.
 */
const frame = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const TodayIcon = () => (
  <svg {...frame}>
    <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
  </svg>
);

export const OrdersIcon = () => (
  <svg {...frame}>
    <rect x="5" y="4" width="14" height="16" rx="2" />
    <path d="M9 9h6M9 13h6M9 17h3" />
  </svg>
);

export const PurchasingIcon = () => (
  <svg {...frame}>
    <path d="M5 9h14l-1.5 9a1 1 0 0 1-1 .8H7.5a1 1 0 0 1-1-.8z" />
    <path d="M9 9V7a3 3 0 0 1 6 0v2" />
  </svg>
);

export const ManageIcon = () => (
  <svg {...frame}>
    <path d="M5 7h9M18 7h1M5 12h1M10 12h9M5 17h7M16 17h3" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="14" cy="17" r="2" />
  </svg>
);

export const ApproveIcon = () => (
  <svg {...frame}>
    <path d="m8 12.5 3 3 5.5-6.5" />
    <rect x="4" y="4" width="16" height="16" rx="4" />
  </svg>
);

export const ReceiveIcon = () => (
  <svg {...frame}>
    <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" />
    <path d="M4 8.5 12 13l8-4.5M12 13v7" />
  </svg>
);

export const CloseDayIcon = () => (
  <svg {...frame}>
    <rect x="4" y="5" width="16" height="15" rx="3" />
    <path d="M4 10h16M9 3v4M15 3v4" />
  </svg>
);

export const ClockIcon = () => (
  <svg {...frame}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l2.5 2" />
  </svg>
);

export const PlusIcon = () => (
  <svg {...frame}>
    <path d="M12 6v12M6 12h12" />
  </svg>
);

export const ChevronIcon = () => (
  <svg {...frame} width={18} height={18} className="shrink-0 rtl:-scale-x-100">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const DismissIcon = () => (
  <svg {...frame} width={18} height={18}>
    <path d="m7 7 10 10M17 7 7 17" />
  </svg>
);

export const SearchIcon = () => (
  <svg {...frame}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.5-4.5" />
  </svg>
);

// The rows of Manage. One shape each: a row is found by its picture on
// the second visit, which it cannot be if four rows share one.
export const TagIcon = () => (
  <svg {...frame}>
    <path d="M4 5h7l9 9-7 7-9-9z" />
    <circle cx="8.5" cy="9.5" r="1" />
  </svg>
);

export const StallIcon = () => (
  <svg {...frame}>
    <path d="M4 10 6 4h12l2 6" />
    <path d="M4 10a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 10" />
    <path d="M6 13v7h12v-7" />
  </svg>
);

export const DishIcon = () => (
  <svg {...frame}>
    <path d="M3 12h18a9 9 0 0 1-18 0z" />
    <path d="M9 4c0 1.5 1.5 1.5 1.5 3M13.5 4c0 1.5 1.5 1.5 1.5 3" />
  </svg>
);

export const ReceiptIcon = () => (
  <svg {...frame}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
    <path d="M9 8h6M9 12h6" />
  </svg>
);

export const StoreIcon = () => (
  <svg {...frame}>
    <path d="M4 9 5.5 4h13L20 9" />
    <path d="M5 9v11h14V9" />
    <path d="M10 20v-6h4v6" />
  </svg>
);

export const ShieldIcon = () => (
  <svg {...frame}>
    <path d="M12 3 5 6v5c0 4.5 2.9 8 7 10 4.1-2 7-5.5 7-10V6z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

export const BuildingIcon = () => (
  <svg {...frame}>
    <rect x="5" y="3" width="14" height="18" rx="1" />
    <path d="M9 7h2M13 7h2M9 11h2M13 11h2M10 21v-4h4v4" />
  </svg>
);

export const WalletIcon = () => (
  <svg {...frame}>
    <path d="M4 7a2 2 0 0 1 2-2h11v4" />
    <rect x="4" y="7" width="16" height="13" rx="2" />
    <path d="M16 13.5h.01" />
  </svg>
);

export const TrendIcon = () => (
  <svg {...frame}>
    <path d="M4 17 9.5 11l3.5 3.5L20 7" />
    <path d="M15 7h5v5" />
  </svg>
);

export const PulseIcon = () => (
  <svg {...frame}>
    <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
  </svg>
);

export const EyeIcon = () => (
  <svg {...frame}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

export const PersonIcon = () => (
  <svg {...frame}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);
