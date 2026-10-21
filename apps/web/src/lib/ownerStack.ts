/**
 * Last-registrant-wins owner stack (2026-10-21 audit CA-34 / E-23).
 *
 * For single-slot UI that several mounted components may want at once
 * (the page main button). Each owner pushes an entry; the TOP entry is
 * what's published. Updating an entry never reorders it, and releasing
 * one (unmount) restores whoever was underneath — instead of the old
 * "last write wins, first unmount clears it for everyone" slot.
 */
export interface OwnerHandle<T> {
  update(value: T): void;
  release(): void;
}

export interface OwnerStack<T> {
  push(value: T): OwnerHandle<T>;
  top(): T | null;
}

export function createOwnerStack<T>(onChange: (top: T | null) => void): OwnerStack<T> {
  const entries: Array<{ value: T }> = [];
  const top = () => entries[entries.length - 1]?.value ?? null;
  const emit = () => onChange(top());
  return {
    push(value) {
      const entry = { value };
      entries.push(entry);
      emit();
      return {
        update(next) {
          entry.value = next;
          if (entries[entries.length - 1] === entry) emit();
        },
        release() {
          const i = entries.lastIndexOf(entry);
          if (i < 0) return;
          const wasTop = i === entries.length - 1;
          entries.splice(i, 1);
          if (wasTop) emit();
        },
      };
    },
    top,
  };
}
