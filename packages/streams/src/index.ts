/**
 * The write side of the event store, shared by the API and the worker
 * (review ORD-07, COREAPI-11): reading and appending a stream, replaying an
 * order session or a run, and the projectors both of them write the read
 * models with. The worker could not import these from apps/api, whose
 * modules read the API's environment when imported, so it kept copies.
 *
 * Nothing here reads the environment: every function takes the database
 * handle (usually the caller's transaction).
 */
export { appendEvents, readStream, type AppendInput, type PersistedEvent } from './eventStore';
export { ConcurrentDraftError, projectOrder } from './orderProjection';
export { loadOrderState, readOrderEvents, writeOrderEvents } from './orderStream';
export { projectRunClaim, type RunClaimEvent } from './runClaimProjection';
export { loadRunState, readRunEvents } from './runStream';
