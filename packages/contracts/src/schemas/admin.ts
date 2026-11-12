/**
 * Admin inputs: roles, members, invitations, a member's stores, stores,
 * the catalog import and the test-data purges.
 *
 * Review ADM1-11 (2026-11-12): the admin router declared most of these
 * inline; it imports them from here now, as the catalog inputs are
 * (catalog.ts). Three shapes no route took left with the move: a
 * test-data purge input and result, and an invite by username or email.
 */
import { z } from 'zod';
import { TG_USER_ID_MESSAGE, TG_USER_ID_RE } from '../limits';
import { TrimmedNameSchema, codeTextSchema } from './catalog';
import { DateStringSchema, TimeZoneSchema, UuidSchema } from './common';

// ---------- Roles ----------

export const GrantRoleInputSchema = z.object({
  userId: UuidSchema,
  roleSlug: z.string(),
  scopeType: z.enum(['global', 'store']).default('global'),
  scopeId: UuidSchema.optional(),
  // 2026-10-21 audit A-23: was a bare string, so garbage became Invalid
  // Date (→ 500) and a past instant stored an already-dead grant.
  expiresAt: z
    .string()
    .datetime({ offset: true, message: 'admin.errors.invalidExpiresAt' })
    .refine((value) => Date.parse(value) > Date.now(), {
      message: 'admin.errors.invalidExpiresAt',
    })
    .optional(),
});

export const RevokeRoleInputSchema = z.object({
  bindingId: UuidSchema,
});

// ---------- Members ----------

export const MemberSetStatusInputSchema = z.object({
  memberId: UuidSchema,
  status: z.enum(['active', 'suspended']),
});

export const MemberSetDisplayNameInputSchema = z.object({
  memberId: UuidSchema,
  displayName: TrimmedNameSchema,
});

export const MemberRemoveInputSchema = z.object({
  memberId: UuidSchema,
});

// ---------- Invitations ----------

/**
 * The stores an invitation adds the person to. At least one, unless the
 * role is admin or super_admin (the server says so: inviteNeedsStore).
 * Review ADM1-12: one plan decides an invite link and an invite by
 * Telegram ID, so both take the same list; the second had no limit.
 */
const InviteStoreIdsSchema = z.array(UuidSchema).max(50).default([]);

export const CreateMemberInviteInputSchema = z.object({
  roleSlug: z.string().min(1).max(64).nullish(),
  storeIds: InviteStoreIdsSchema,
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

export const InviteMemberByTgIdInputSchema = z.object({
  tgUserId: z
    .string()
    .regex(TG_USER_ID_RE, TG_USER_ID_MESSAGE)
    .transform((s) => BigInt(s)),
  displayName: TrimmedNameSchema.optional(),
  roleSlug: z.string().min(1).max(64).optional(),
  storeIds: InviteStoreIdsSchema,
});

/** 2026-10-21 CA-19: withdraw a pending shareable invite link. */
export const MemberInviteRevokeInputSchema = z.object({
  inviteId: UuidSchema,
});

// ---------- A member's stores ----------

export const MemberAssignStoreInputSchema = z.object({
  memberId: UuidSchema,
  storeId: UuidSchema,
});

export const MemberUnassignStoreInputSchema = z.object({
  memberId: UuidSchema,
  storeId: UuidSchema,
});

export const MemberDetachFromStoreInputSchema = z.object({
  memberId: UuidSchema,
  storeId: UuidSchema,
});

export const MemberTransferStoreInputSchema = z.object({
  memberId: UuidSchema,
  fromStoreId: UuidSchema,
  toStoreId: UuidSchema,
  /** When true (default) we mirror role bindings: every store-scoped
   *  binding the member had in `fromStoreId` is recreated against
   *  `toStoreId` so they keep the same operational role at the new
   *  location. When false we only move the MSA assignment and let
   *  the operator grant roles separately. */
  mirrorRoles: z.boolean().default(true),
});

// ---------- Stores ----------

/** A store's own time zone, or empty/null to follow the organisation's (CLS-7). */
const StoreTimeZoneSchema = z
  .preprocess((value) => (value === '' ? null : value), TimeZoneSchema.nullable())
  .optional();

// ADM-11 (2026-10-30): an empty code means no code. Names and codes are
// trimmed and refuse control characters (TrimmedNameSchema, F10).
const StoreCodeSchema = z
  .preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    codeTextSchema(32).nullable(),
  )
  .optional();

export const StoreCreateInputSchema = z.object({
  name: TrimmedNameSchema,
  code: StoreCodeSchema,
  address: z.string().max(500).optional().nullable(),
  timezone: StoreTimeZoneSchema,
});

export const StoreUpdateInputSchema = z.object({
  storeId: UuidSchema,
  name: TrimmedNameSchema.optional(),
  code: StoreCodeSchema,
  address: z.string().max(500).optional().nullable(),
  timezone: StoreTimeZoneSchema,
  isActive: z.boolean().optional(),
  /** D3: default role for new members invited into this store. Pass
   *  `null` to clear; pass an existing role's slug to set. The slug
   *  is resolved to a role-id server-side; cross-tenant role-ids
   *  can't slip in. */
  defaultRoleSlug: z.string().min(1).max(64).nullable().optional(),
});

export const StoreCloneRolesInputSchema = z.object({
  sourceStoreId: UuidSchema,
  targetStoreId: UuidSchema,
  /** When true, the source's active members come along: their roles in
   *  the source store and their assignment to it. Off by default, when
   *  only the default role is copied — chain expansion usually wants the
   *  ROLE shape replicated but staffed by different people (ADM2-31). */
  includeMembers: z.boolean().default(false),
});

export const StoreDeleteInputSchema = z.object({
  storeId: UuidSchema,
});

// ---------- Catalog import ----------

export const CatalogImportInputSchema = z.object({
  sourceOrgId: UuidSchema,
  includeSuppliers: z.boolean(),
});

// ---------- Test-data purges ----------

/**
 * Purge ALL transactional data for the caller's org: its orders, runs and
 * events and what hangs off them (workspacePurge in
 * services/purgePlans.ts lists the tables). Does NOT touch:
 *   - org / user / member / role rows (the workspace stays alive)
 *   - stores / categories / skus / suppliers (the catalog stays)
 *   - the admin audit (kept for forensics; CAT-5)
 *   - sync.idempotency_keys and domain.projector_cursors (system-level)
 * A workspace with a daily close is refused (CAT-2).
 *
 * Two-phase by design:
 *   - dryRun=true (default) returns row counts WITHOUT deleting.
 *   - dryRun=false requires `confirmText` to match the workspace name
 *     (DX-CAT-17; the slug is still accepted from older clients). The FE
 *     shows the name in the confirm sheet so the user literally types
 *     it; if they fat-finger, nothing happens.
 */
export const PurgeAllTestDataInputSchema = z.object({
  dryRun: z.boolean().default(true),
  confirmText: z.string().optional(),
});

/**
 * Purge a single day's order→run→delivery flow. Scoped by date (the
 * orderDate on sessions / runDate on runs); everything else is left
 * alone. This is the "I just tested a complete flow, let me re-test
 * tomorrow… actually let me re-test in 30 seconds" knob.
 *
 * No typed confirm needed — the date itself is the safety: if the user
 * passed the wrong date, the dryRun's row counts will reveal it before
 * they tap commit.
 */
export const PurgeByDateInputSchema = z.object({
  date: DateStringSchema,
  dryRun: z.boolean().default(true),
});

/**
 * Targeted single-session purge. The common case: an admin placed a
 * test order at the same time real staff are placing real orders, and
 * needs to wipe ONLY their own test session — surgically — without
 * touching anyone else's data.
 *
 * Cascade rules:
 *   - status in {draft, submitted, rejected, approved}: delete the
 *     session + items + events + snapshots + notifications. The
 *     session is not part of any run yet, so nothing else is touched.
 *   - status in {in_run, archived}: REFUSED. Caller must purge the
 *     run instead (or eject the session via the normal run UI first).
 *     We refuse rather than silently mutating run aggregates because
 *     re-deriving a run's planned totals after a partial deletion is
 *     a non-trivial replay job.
 */
export const PurgeSessionInputSchema = z.object({
  sessionId: UuidSchema,
  dryRun: z.boolean().default(true),
  // CAT-3 (2026-10-30): same guard as purgeRun — only the caller's own
  // test orders, unless explicitly waived.
  requireOnlyTestSessions: z.boolean().default(true),
});

/**
 * Whole-run purge. Deletes the run + every session attached to it +
 * every event/store-delivery/notification derived from that flow.
 *
 * Use this when an admin tested through to delivery (so the session
 * is in_run/archived and can't be deleted in isolation), OR when a
 * test run was created with multiple test sessions inside it.
 *
 * SAFETY: if `requireOnlyTestSessions: true` (default), refuses if
 * any attached session was created by a member OTHER than the caller.
 * That way you can't accidentally nuke a real run that just happens
 * to share a runId with a test session.
 */
export const PurgeRunInputSchema = z.object({
  runId: UuidSchema,
  dryRun: z.boolean().default(true),
  requireOnlyTestSessions: z.boolean().default(true),
});
