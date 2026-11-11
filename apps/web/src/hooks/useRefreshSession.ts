/**
 * Re-read `auth.me` and write it into the auth store (2026-10-21 FE-06).
 *
 * The session snapshot (stores, adminStoreIds, permissions…) is only
 * refreshed at boot by AuthGate. Anything that changes org structure —
 * creating / renaming / archiving a store — left every picker that reads
 * `session.stores` / `session.adminStoreIds` stale until the mini-app was
 * reopened (a brand-new store couldn't be picked for invites or grants).
 *
 * Writes through `patchSession` (tokens untouched), and the fetch also
 * lands in the `auth.me` query cache, so AuthGate's own effect sees the
 * same data. Failures are swallowed: a stale picker is not worth an
 * error toast on top of the mutation's success toast.
 *
 * Review COREWEB2-14 (2026-11-11): the hook was in lib/refreshSession.ts,
 * which keeps applyRefreshedSession.
 */
import { useCallback } from 'react';
import { trpc } from '../lib/trpc';
import { applyRefreshedSession } from '../lib/refreshSession';

export function useRefreshSession(): () => Promise<boolean> {
  const utils = trpc.useUtils();
  return useCallback(async () => {
    try {
      const session = await utils.auth.me.fetch(undefined, { staleTime: 0 });
      return applyRefreshedSession(session);
    } catch {
      return false;
    }
  }, [utils]);
}
