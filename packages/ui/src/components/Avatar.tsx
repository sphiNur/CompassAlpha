import { cn } from '../cn';

interface AvatarProps {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
}

export function Avatar({ src, name, size = 32, className }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={style}
        className={cn('rounded-full bg-[var(--c-surface-2)] object-cover ring-hairline', className)}
        loading="lazy"
      />
    );
  }
  return (
    <span
      style={style}
      aria-label={name}
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-[var(--c-surface-2)] font-semibold text-[var(--c-fg-muted)] ring-hairline',
        className,
      )}
    >
      {initials || '?'}
    </span>
  );
}
