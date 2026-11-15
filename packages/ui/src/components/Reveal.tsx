import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Content that opens and closes with motion, not in one frame (owner
 * 2026-11-16: "a complete animation system, not instant changes";
 * modern-web-guidance: animate-element-entry-exit). Its children are
 * drawn only while open, as the groups that use it did by hand, so what
 * they load still waits for the open. On close the last children stay
 * for REVEAL_MS, inert and hidden from assistive tech, while they fold
 * away (.app-reveal in tokens.css): height and fade where the browser
 * can animate to `auto` (interpolate-size), fade alone elsewhere, nothing
 * under reduced motion.
 */
export const REVEAL_MS = 240;

export interface RevealProps {
  open: boolean;
  children: ReactNode;
  id?: string;
  className?: string;
  /** The element to draw; a list's items need a `ul`. */
  as?: 'div' | 'ul' | 'section';
  role?: string;
}

export function Reveal({ open, children, id, className, as = 'div', role }: RevealProps) {
  const [prevOpen, setPrevOpen] = useState(open);
  const [closing, setClosing] = useState(false);
  // Worked out while rendering (React's "state from the previous
  // render"), so the closing frame is never skipped.
  if (prevOpen !== open) {
    setPrevOpen(open);
    setClosing(!open && !prefersReducedMotion());
  }
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(false), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  const ref = useRef<HTMLElement>(null);
  // React 18 has no `inert` prop: a closing copy takes no taps or focus.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (closing) el.setAttribute('inert', '');
    else el.removeAttribute('inert');
  }, [closing]);
  if (!open && !closing) return null;
  const Tag = as;
  return (
    <Tag
      ref={ref as never}
      id={closing ? undefined : id}
      role={role}
      data-reveal=""
      data-closing={closing ? '' : undefined}
      aria-hidden={closing || undefined}
      className={cn('app-reveal', className)}
    >
      {children}
    </Tag>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
