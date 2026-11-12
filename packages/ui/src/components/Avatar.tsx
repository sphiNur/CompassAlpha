import { useState } from 'react';
import { cn } from '../cn';

export interface AvatarProps {
  src?: string | null;
  /** Whose avatar: gives the initials shown when there is no photo. */
  name: string;
  /**
   * What a screen reader says for the avatar. Leave it out where the
   * name is written next to the avatar (every use today): the avatar is
   * then decorative and the name is not read twice (review UI-24).
   */
  label?: string;
  size?: number;
  className?: string;
}

/**
 * Up to two initials: the first letter or digit of each of the first two
 * words that have one. Review UI-24 (2026-11-12): this took `word[0]`, one
 * UTF-16 unit, so a Telegram name that starts with an emoji showed half a
 * surrogate pair (U+FFFD), and "Anna (Smoke Store)" gave "A(". Exported for
 * tests.
 */
export function avatarInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .map((word) => /[\p{L}\p{N}]/u.exec(word)?.[0])
    .filter((initial): initial is string => initial !== undefined)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return initials || '?';
}

export function Avatar({ src, name, label, size = 32, className }: AvatarProps) {
  // The photo that failed to load (a stale Telegram link): the initials
  // stand in for it instead of a broken image (UI-24). A new src tries
  // again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (src && src !== failedSrc) {
    return (
      <img
        src={src}
        alt={label ?? ''}
        style={style}
        className={cn('rounded-full bg-[var(--c-surface-2)] object-cover ring-hairline', className)}
        loading="lazy"
        onError={() => setFailedSrc(src)}
      />
    );
  }
  return (
    <span
      style={style}
      // A span's aria-label alone is not read by most screen readers;
      // with a label the avatar is an image.
      {...(label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-[var(--c-surface-2)] font-semibold text-[var(--c-fg-muted)] ring-hairline',
        className,
      )}
    >
      {avatarInitials(name)}
    </span>
  );
}
