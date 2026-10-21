-- 0051_backfill_transfer_audit_scope.sql
--
-- (2026-10-21) admin.memberTransferStore audit rows were written with a
-- NULL scope_store_id: deriveScopeStoreId looked for a `targetStoreId`
-- key, but the transfer input carries `fromStoreId` / `toStoreId`. Store-
-- level admins filter the audit list by scope_store_id, so they never saw
-- transfers. New rows now scope to the destination (`toStoreId`); this
-- backfills existing rows the same way. adminAuditList additionally
-- matches `inputs->>'fromStoreId'`, so the source store's admins see them
-- too.
--
-- SAFETY: idempotent (only NULL scopes, only well-formed UUIDs); touches
-- nothing but this one column on this one action. policy_decisions is
-- under FORCE RLS, so the system context is declared first.
SELECT set_config('app.system_context', 'maintenance', true);
--> statement-breakpoint
UPDATE domain.policy_decisions
SET scope_store_id = (inputs ->> 'toStoreId')::uuid
WHERE action = 'admin.memberTransferStore'
  AND scope_store_id IS NULL
  AND (inputs ->> 'toStoreId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
