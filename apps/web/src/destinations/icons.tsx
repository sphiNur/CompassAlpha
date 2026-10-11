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
