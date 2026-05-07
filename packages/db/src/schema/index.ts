/**
 * Compass DB schema â€?Drizzle definitions.
 *
 * Schemas (Postgres logical schemas):
 *   auth.*         organizations, users, members, roles, policies
 *   inventory.*    stores, suppliers, categories, skus, prices
 *   domain.*       events (event-source-of-truth) + snapshots
 *   read_model.*   projections from event streams (rebuildable)
 *   ops.*          notifications, audit, feature flags, client_logs
 *   sync.*         outbox, idempotency
 *
 * RLS is applied via raw SQL in migrations/001_init.sql; the policies
 * reference current_setting('app.current_org_id').
 */
export * from './auth';
export * from './inventory';
export * from './domain';
export * from './readModel';
export * from './ops';
export * from './sync';
