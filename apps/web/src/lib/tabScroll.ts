/**
 * DX-SHL-10 (2026-11-01): each bottom tab keeps its own scroll position.
 * The shell unmounts a page when its tab is left (`key={tab}`), so coming
 * back started at the top; a purchaser flicking to History lost his place.
 */
export function createTabScrollMemory<K extends string>() {
  const positions = new Map<K, number>();
  return {
    save(tab: K, top: number) {
      positions.set(tab, Math.max(0, Math.round(top)));
    },
    get(tab: K): number {
      return positions.get(tab) ?? 0;
    },
    clear() {
      positions.clear();
    },
  };
}

type Scroller = { scrollTop: number; scrollHeight: number; clientHeight: number };

/**
 * Puts `el` back at `top`. A page that loads its data after mounting is
 * too short at first, so this retries each frame until the content is
 * tall enough (or `maxFrames` pass). The returned function stops it; the
 * shell calls it when the person scrolls or leaves the tab first.
 */
export function restoreScroll(
  el: Scroller,
  top: number,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
  maxFrames = 60,
): () => void {
  let frame = 0;
  let id = 0;
  let stopped = false;
  const step = () => {
    if (stopped) return;
    el.scrollTop = top;
    frame++;
    if (el.scrollHeight - el.clientHeight >= top || frame >= maxFrames) return;
    id = raf(step);
  };
  step();
  return () => {
    stopped = true;
    caf(id);
  };
}
