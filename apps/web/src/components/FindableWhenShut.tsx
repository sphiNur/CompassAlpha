import { useLayoutEffect, useRef } from 'react';

/**
 * MWG `defer-rendering-heavy-content` (2026-11-15): a shut group draws
 * none of its rows (RUNWEB1-34). That keeps long runs fast, but the
 * browser's find-in-page could no longer find a product in a shut
 * group. This renders the product NAMES only (not the full rows) as
 * `hidden="until-found"`: find-in-page matches them, the browser fires
 * `beforematch`, and `onFound` opens the group so the real rows mount.
 *
 * Feature-detected: browsers without `beforematch` get nothing, which
 * is exactly the old behaviour. React 18 renders `hidden` as a
 * boolean, so the `until-found` value is set on the node directly.
 */
const SUPPORTED = typeof document !== 'undefined' && 'onbeforematch' in document.body;

export function FindableWhenShut({
  names,
  onFound,
}: {
  names: readonly string[];
  onFound: () => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const onFoundRef = useRef(onFound);
  onFoundRef.current = onFound;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('hidden', 'until-found');
    const handle = () => onFoundRef.current();
    el.addEventListener('beforematch', handle);
    return () => el.removeEventListener('beforematch', handle);
  }, []);

  if (!SUPPORTED || names.length === 0) return null;
  return (
    // No padding or margin: an until-found element keeps its box (only
    // its content is skipped), so any padding would show as an empty
    // strip under every shut group. Unpadded, it is zero height.
    <ul ref={ref} hidden data-findable-shut>
      {names.map((name, i) => (
        <li key={i}>{name}</li>
      ))}
    </ul>
  );
}
