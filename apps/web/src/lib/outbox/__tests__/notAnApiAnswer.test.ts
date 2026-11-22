/**
 * An error page from something in front of the api (nginx's 413 for a
 * body over its limit, a firewall 403 at the edge) used to reach the
 * outbox as a bare JSON parse failure with no code and no status. The
 * replay took that for "no answer" and stopped without counting a retry,
 * so the entry was sent again every 15 s for good and every later write
 * waited behind it, with nothing on screen.
 *
 * authFetch now names such an answer (NotAnApiAnswerError), and the
 * replay counts it toward giving up like any refusal the api returned.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TRPCClientError } from '@trpc/client';
import { authFetch, resetRefreshCooldownForTests } from '../../trpc';
import {
  isLikelyNetworkError,
  NotAnApiAnswerError,
  notAnApiAnswerStatus,
} from '../../networkError';
import { classifyReplayError, replayCountsTowardGiveUp, staysQueued } from '../policy';
import { useAuthStore } from '../../../stores/authStore';

const realFetch = globalThis.fetch;
const initialAuth = useAuthStore.getState();

function answer(status: number, body: string, contentType: string): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(body, { status, headers: { 'content-type': contentType } })) as typeof fetch;
}

beforeEach(() => {
  resetRefreshCooldownForTests();
  useAuthStore.setState({ accessToken: 'token', refreshToken: 'refresh' });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  useAuthStore.setState(initialAuth, true);
  resetRefreshCooldownForTests();
});

describe('authFetch and an answer that is not the api’s', () => {
  it('names an HTML error page with its status', async () => {
    answer(413, '<html><body>413 Request Entity Too Large</body></html>', 'text/html');
    const err = await authFetch('/trpc/run.purchaseItem', { method: 'POST' }).catch((e) => e);
    expect(err).toBeInstanceOf(NotAnApiAnswerError);
    expect(notAnApiAnswerStatus(err)).toBe(413);
    // Not a network failure: the request was answered.
    expect(isLikelyNetworkError(err)).toBe(false);
  });

  it('passes the api’s own JSON refusals and successes through untouched', async () => {
    answer(400, '{"error":{}}', 'application/json');
    expect((await authFetch('/trpc/run.purchaseItem', { method: 'POST' })).status).toBe(400);
    answer(200, '{"result":{}}', 'application/json');
    expect((await authFetch('/trpc/run.get')).status).toBe(200);
  });
});

describe('a replay refused by an error page', () => {
  // As tRPC hands it to the caller: the thrown error is kept as `cause`.
  const refused = (status: number) => TRPCClientError.from(new NotAnApiAnswerError(status));

  it('counts toward giving up, with backoff, instead of blocking the queue for good', () => {
    for (const status of [400, 403, 404, 413, 500]) {
      expect(notAnApiAnswerStatus(refused(status))).toBe(status);
      expect(classifyReplayError(undefined, 'run.purchaseItem', 0)).toBe('retry');
      expect(replayCountsTowardGiveUp(refused(status))).toBe(true);
    }
  });

  it('408 and 429 mean "later": the entry stays queued without counting', () => {
    expect(replayCountsTowardGiveUp(refused(408))).toBe(false);
    expect(replayCountsTowardGiveUp(refused(429))).toBe(false);
  });

  it('changes nothing for failures that carry a tRPC code or got no answer', () => {
    const coded = (code: string) => Object.assign(new Error('x'), { data: { code } });
    expect(replayCountsTowardGiveUp(coded('INTERNAL_SERVER_ERROR'))).toBe(true);
    expect(replayCountsTowardGiveUp(coded('UNAUTHORIZED'))).toBe(false);
    expect(replayCountsTowardGiveUp(coded('SERVICE_UNAVAILABLE'))).toBe(false);
    expect(replayCountsTowardGiveUp(TRPCClientError.from(new TypeError('Failed to fetch')))).toBe(
      false,
    );
  });

  it('a live send refused this way still leaves its entry queued for the replay', () => {
    expect(staysQueued(refused(413))).toBe(true);
  });
});
