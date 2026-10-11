import { cn } from '../cn';

export interface MoneyProps {
  /** Already formatted for display, e.g. "114,000". The kit does no maths. */
  amount: string;
  /** ISO code shown after the figure. Omit where a heading already names it. */
  currency?: string;
  /** `lg` is for the one total a screen is about; rows use the default. */
  size?: 'md' | 'lg';
  tone?: 'ink' | 'primary' | 'secondary' | 'danger';
  className?: string;
}

const TONE = {
  ink: 'text-ink',
  primary: 'text-forest',
  secondary: 'text-secondary',
  danger: 'text-danger',
} as const;

/**
 * An amount. Tabular figures and no wrapping, so that amounts stacked in
 * a right-aligned column line up digit for digit.
 */
export function Money({ amount, currency, size = 'md', tone = 'ink', className }: MoneyProps) {
  return (
    <span className={cn('whitespace-nowrap', TONE[tone], className)} data-money>
      <span className={size === 'lg' ? 'text-money-lg' : 'text-money'}>{amount}</span>
      {currency ? <span className="ml-xs text-caption text-secondary">{currency}</span> : null}
    </span>
  );
}
