export interface SpinnerProps {
  size?: number;
  className?: string;
}

/**
 * Review MWB-08 (modern-web-guidance: spinner): under reduced motion the
 * ring turns slowly (6 s a turn) instead of at 900 ms, "rather than
 * stopping it entirely, so the user still knows that the process is
 * active". The token reset in tokens.css does not reach a literal duration.
 */
export const SPINNER_CLASS =
  'animate-[spin_900ms_linear_infinite] motion-reduce:[animation-duration:6s]';

export function Spinner({ size = 20, className }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`${SPINNER_CLASS} ${className ?? ''}`}
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
