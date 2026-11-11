/**
 * Compass DB schema — Drizzle definitions.
 *
 * Schemas (Postgres logical schemas):
 *   auth.*         organizations, users, members, roles, policies
 *   inventory.*    stores, suppliers, categories, skus, prices
 *   domain.*       events (event-source-of-truth) + snapshots
 *   read_model.*   projections from event streams (rebuildable)
 *   ops.*          notifications, audit, feature flags, client_logs
 *   sync.*         outbox, idempotency
 *
 * Row-level security is plain SQL, not Drizzle: every migrate runs
 * migrations/sql/900_rls_policies.sql and 950_rls_fail_closed.sql after
 * the numbered migrations, and some numbered migrations add policies of
 * their own. The policies compare org_id with app_current_org(), which
 * reads current_setting('app.current_org_id').
 */
export * from './auth';
export * from './inventory';
export * from './domain';
export * from './readModel';
export * from './ops';
export * from './sync';
