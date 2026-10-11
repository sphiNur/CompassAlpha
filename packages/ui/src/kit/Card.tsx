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
      <div className={cn('rounded-lg bg-surface p-lg', className)}>{children}</div>
    </InsideCard.Provider>
  );
}

export interface ListProps {
  children: ReactNode;
  className?: string;
}

/**
 * Rows that belong together. They sit on the page itself, as in the
 * Wise app's lists: no surface under them and no lines between them;
 * the space around the group is what groups it.
 */
export function List({ children, className }: ListProps) {
  return (
    <div role="list" className={cn('flex flex-col', className)}>
      {children}
    </div>
  );
}
