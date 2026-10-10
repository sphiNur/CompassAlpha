import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../cn';

const InsideCard = createContext(false);

export interface CardProps {
  children: ReactNode;
  className?: string;
}

/**
 * One level of grouping: a white surface on the page's paper. There is
 * no second level. A card inside a card is reported in development,
 * because it is how screens get dense again.
 */
export function Card({ children, className }: CardProps) {
  const nested = useContext(InsideCard);
  if (nested && typeof console !== 'undefined') {
    console.error('kit: a Card was rendered inside another Card. Use a List or a Section instead.');
  }
  return (
    <InsideCard.Provider value={true}>
      <div className={cn('rounded-md bg-surface p-lg', className)}>
        {children}
      </div>
    </InsideCard.Provider>
  );
}

export interface ListProps {
  children: ReactNode;
  className?: string;
}

/**
 * Rows that belong together, separated by hairlines, on one surface.
 * Counts as a card for the nesting rule.
 */
export function List({ children, className }: ListProps) {
  const nested = useContext(InsideCard);
  if (nested && typeof console !== 'undefined') {
    console.error('kit: a List was rendered inside a Card. A List is already a surface.');
  }
  return (
    <InsideCard.Provider value={true}>
      <div
        role="list"
        className={cn(
          'inset-separated overflow-hidden rounded-md bg-surface',
          className,
        )}
      >
        {children}
      </div>
    </InsideCard.Provider>
  );
}
