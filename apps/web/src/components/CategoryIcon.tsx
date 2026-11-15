/**
 * A product category's picture (UI overhaul, 2026-11-15, owner: category
 * icons instead of product photos). Line art in the nav icons' style,
 * currentColor, chosen from the category's names (lib/categoryIcon.ts).
 * Decorative: the category's name is always written beside it.
 */
import type { ReactNode } from 'react';
import { categoryIconKind, type CategoryIconKind } from '../lib/categoryIcon';

const PATHS: Record<CategoryIconKind, ReactNode> = {
  meat: (
    <>
      <path d="M3.5 13.5C3.5 8.8 7.6 5 12.8 5c4.4 0 7.7 2.6 7.7 6.2 0 4.4-3.9 7.8-9.3 7.8-4.6 0-7.7-2.2-7.7-5.5Z" />
      <circle cx="9.5" cy="12" r="2" />
      <path d="M14 15.5c1.8-.4 3.3-1.6 4-3.2" />
    </>
  ),
  fish: (
    <>
      <path d="M3 12c3-4 7-5.5 11-4.5 2.3.6 4 2.2 5 4.5-1 2.3-2.7 3.9-5 4.5-4 1-8-.5-11-4.5Z" />
      <path d="M19 12l2.5-2.5v5Z" />
      <circle cx="8" cy="11" r=".75" />
    </>
  ),
  vegetables: (
    <>
      <path d="M7 20c-1.5-1.5-1-4.5 1.5-7l5-5c1.5-1.5 4-1 5 0s1.5 3.5 0 5l-5 5c-2.5 2.5-5.5 3-7 2Z" />
      <path d="M17 7l2.5-2.5M16 5l1-2M19 8l2-1" />
      <path d="M10 14l2 2M12 12l1.5 1.5" />
    </>
  ),
  fruit: (
    <>
      <path d="M12 7c-1.5-1-5-1.2-6.5 1.5-1.8 3.4.2 9.5 3.5 11 1.2.5 2 .2 3-.3 1 .5 1.8.8 3 .3 3.3-1.5 5.3-7.6 3.5-11C17 5.8 13.5 6 12 7Z" />
      <path d="M12 7c0-2 1-3.5 3-4" />
    </>
  ),
  dairy: (
    <>
      <path d="M9 3h6v3l2 3v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V9l2-3Z" />
      <path d="M7 12h10" />
    </>
  ),
  eggs: (
    <path d="M12 3c3.5 0 6.5 5.5 6.5 10a6.5 6.5 0 0 1-13 0C5.5 8.5 8.5 3 12 3Z" />
  ),
  bakery: (
    <>
      <path d="M4 12a4 4 0 0 1 3-6.5c1.5-1 3.2-1.5 5-1.5s3.5.5 5 1.5A4 4 0 0 1 20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z" />
      <path d="M9 9v3M12 8v4M15 9v3" />
    </>
  ),
  grains: (
    <>
      <path d="M5 11h14l-1.5 8a1 1 0 0 1-1 .8h-9a1 1 0 0 1-1-.8Z" />
      <path d="M8 11c0-3 1.8-5 4-5s4 2 4 5" />
      <path d="M12 6V3" />
    </>
  ),
  drinks: (
    <>
      <path d="M7 4h10l-1.5 15.2a1 1 0 0 1-1 .8h-5a1 1 0 0 1-1-.8Z" />
      <path d="M7.5 9h9" />
    </>
  ),
  spices: (
    <>
      <path d="M8 8h8v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1Z" />
      <path d="M9 4h6v4H9Z" />
      <path d="M11 6h.01M13 6h.01" />
    </>
  ),
  oil: (
    <>
      <path d="M10 3h4v3l2 3v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V9l2-3Z" />
      <path d="M12 12c1 1.2 1.5 2 1.5 2.7a1.5 1.5 0 0 1-3 0c0-.7.5-1.5 1.5-2.7Z" />
    </>
  ),
  frozen: (
    <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5" />
  ),
  tools: (
    <>
      <path d="M7 3v7a2 2 0 0 0 2 2v9M5 3v5M9 3v5" />
      <path d="M17 21V3c-2 1.5-3 4-3 7v3h3" />
    </>
  ),
  cleaning: (
    <>
      <path d="M9 9h6l1 11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1Z" />
      <path d="M10 9V6h4v3M14 6l3-2" />
      <path d="M18.5 8.5h.01M20 11h.01M18 12.5h.01" />
    </>
  ),
  linen: (
    <>
      <path d="M4 6h16v4H4Z" />
      <path d="M6 10v9h12v-9" />
      <path d="M9 14h6" />
    </>
  ),
  packaging: (
    <>
      <path d="M4 8l8-4 8 4v8l-8 4-8-4Z" />
      <path d="M4 8l8 4 8-4M12 12v8" />
    </>
  ),
  other: (
    <>
      <path d="M5 7h14v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1Z" />
      <path d="M4 4h16v3H4ZM10 11h4" />
    </>
  ),
};

export function CategoryIcon({
  names,
  size = 16,
  className,
}: {
  names: Readonly<Record<string, string | null | undefined>>;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {PATHS[categoryIconKind(names)]}
    </svg>
  );
}
