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
