/**
 * Pass changes announced in the database (by the worker) on to the hub.
 * See packages/db/src/realtime.ts for why and how.
 */
import { parseRealtimeNotice, REALTIME_CHANNEL } from '@compass/db';
import { hub } from './hub';

/** The part of a postgres.js client this needs. */
interface Listener {
  listen(
    channel: string,
    onNotify: (payload: string) => void,
  ): Promise<{ unlisten: () => Promise<void> }>;
}

/** Handle one NOTIFY payload. Exported for tests. */
export function relayRealtimeNotice(payload: string): boolean {
  const message = parseRealtimeNotice(payload);
  if (!message) return false;
  hub.publish(message.orgId, message);
  return true;
}

/**
 * Listen on the realtime channel for the life of the process. postgres.js
 * keeps a dedicated connection for it and re-listens after a reconnect.
 */
export async function relayDatabaseNotices(client: Listener): Promise<() => Promise<void>> {
  const sub = await client.listen(REALTIME_CHANNEL, (payload) => {
    relayRealtimeNotice(payload);
  });
  return sub.unlisten;
}
