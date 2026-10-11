import type { ReactNode } from 'react';
import { cn } from '../cn';

export type TileTone = 'orange' | 'blue' | 'gray';

export interface TileProps {
  /** What is being counted: "Waiting for approval". */
  label: string;
  /** How many. Shown large in the top right corner, including zero. */
  count: number;
  /** A colour per kind of work, so the grid reads before the words do. */
  tone: TileTone;
  onPress: () => void;
  'data-testid'?: string;
}

const TONE: Record<TileTone, string> = {
  orange: 'bg-hero',
  blue: 'bg-hero',
  gray: 'bg-hero',
};

/**
 * A count of things waiting, as a coloured block that goes to them: the
 * tiles at the top of iOS Reminders. The number is the content, so a tile
 * exists only for something that can be counted.
 */
export function Tile({ label, count, tone, onPress, ...rest }: TileProps) {
  return (
    <button
      type="button"
      data-testid={rest['data-testid']}
      data-tile={tone}
      onClick={onPress}
      className={cn(
        'flex min-w-0 flex-col justify-between gap-sm rounded-lg p-lg text-start text-on-hero',
        'outline-none active:opacity-80 focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2',
        TONE[tone],
      )}
    >
      <span className="self-end text-money-lg">{count}</span>
      <span className="text-label">{label}</span>
    </button>
  );
}

/** Tiles side by side, two to a row. */
export function TileGrid({ children }: { children: ReactNode }) {
  // An odd one out takes the full width instead of leaving a hole.
  return (
    <div className="grid grid-cols-2 gap-md [&>*:last-child:nth-child(odd)]:col-span-2">
      {children}
    </div>
  );
}
