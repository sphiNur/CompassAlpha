/**
 * DX-ORD-1 (2026-11-01): writes a screen holds that are not mutations yet.
 *
 * The Order page keeps each +/− tap in a 200 ms debounce before it becomes
 * an `order.adjustItem` mutation. `queryClient.isMutating()` cannot see
 * those taps, so a realtime refetch started inside the window came back
 * with the server's older value and overwrote the tap on screen; the next
 * tap then built on the old value and a step was lost.
 *
 * A screen registers a probe here; realtime asks before it invalidates.
 */
type Probe = () => boolean;

const probes = new Set<Probe>();

/** Register a "do you still hold unsent writes?" probe. Returns the unregister. */
export function registerLocalWrites(probe: Probe): () => void {
  probes.add(probe);
  return () => {
    probes.delete(probe);
  };
}

/** True while any registered screen holds writes the server has not confirmed. */
export function hasLocalWrites(): boolean {
  for (const probe of probes) {
    try {
      if (probe()) return true;
    } catch {
      /* a broken probe must not block refreshes */
    }
  }
  return false;
}
