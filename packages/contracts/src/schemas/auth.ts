import { z } from 'zod';
import {
  CONTROL_CHARS_MESSAGE,
  LocaleSchema,
  noControlChars,
  TimeZoneSchema,
  UuidSchema,
} from './common';

export const TelegramLoginInputSchema = z.object({
  initData: z.string().min(1),
  /** Optional locale override; otherwise we use Telegram's user.language_code. */
  locale: LocaleSchema.optional(),
});

/**
 * Opening an invite link is a sign-in: Telegram proves who is asking,
 * and the token proves which organisation invited them. The token is
 * the only client-supplied grant selector; role and stores come from
 * the server-side invite snapshot.
 */
export const AcceptInviteInputSchema = z.object({
  initData: z.string().min(1),
  token: z
    .string()
    .min(20)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'invite token has an invalid shape'),
  locale: LocaleSchema.optional(),
});

export const NonTelegramLoginInputSchema = z.object({
  tgUserId: z.string().regex(/^\d{4,20}$/),
  accessCode: z.string().min(1).max(256),
  locale: LocaleSchema.optional(),
});

/**
 * A refresh token is a JWT carrying three UUIDs; ours come out at 296
 * characters. The cap here used to be 200, so the schema rejected every
 * token the server itself issued and `auth.refresh` answered 400 to all
 * of them. Keep the bound generous: it is only there to stop absurd
 * input, not to describe the token.
 */
export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(20).max(4096),
});

export const StoreSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  code: z.string().nullable(),
  isActive: z.boolean(),
});

/**
 * One organisation the signed-in user can enter. Returned on every
 * session so the client can offer a workspace switcher without a
 * separate tenant-discovery endpoint.
 */
export const OrganizationMembershipSchema = z.object({
  orgId: UuidSchema,
  orgSlug: z.string(),
  orgName: z.string(),
  memberId: UuidSchema,
  status: z.string(),
  joinedAt: z.string(),
});

export const SubscriptionSummarySchema = z.object({
  planCode: z.string(),
  planName: z.string(),
  status: z.enum(['trialing', 'active', 'past_due', 'suspended', 'canceled']),
  writeAccess: z.boolean(),
  trialEndsAt: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  graceEndsAt: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  limits: z.object({
    stores: z.number().int().nullable(),
    members: z.number().int().nullable(),
  }),
  usage: z.object({
    stores: z.number().int(),
    members: z.number().int(),
  }),
});

export const MemberSummarySchema = z.object({
  memberId: UuidSchema,
  orgId: UuidSchema,
  orgSlug: z.string(),
  orgName: z.string(),
  status: z.string(),
  /**
   * M1.17 (2026-05-08): org-level financial settings snapshot.
   * Optional in the schema for backward compatibility with sessions
   * minted by older servers — the FE falls back to UZS / 0% / gross
   * when missing.
   */
  currency: z.string().length(3).optional(),
  taxRatePct: z.string().optional(),
  pricesIncludeTax: z.boolean().optional(),
  /** HIS-13 (2026-10-30): the org's time zone, for "today" / "this month"
   *  presets. Optional for sessions minted by older servers. */
  timezone: z.string().optional(),
});

export const SessionSchema = z.object({
  user: z.object({
    id: UuidSchema,
    displayName: z.string(),
    /** Once true, user can no longer change their own name — admin only. */
    displayNameLocked: z.boolean(),
    avatarUrl: z.string().nullable(),
    locale: LocaleSchema,
    /**
     * M3.45 (2026-05-22): secondary display language. When non-null,
     * the UI shows product names as "Primary (Secondary)" and the
     * per-vendor copy templates use the secondary locale exclusively
     * (so a Chinese-speaking purchaser can paste a Uzbek list straight
     * to the vendor chat). Null = single-language default behavior.
     */
    secondaryLocale: LocaleSchema.nullable(),
    tgUsername: z.string().nullable(),
    /**
     * CMP-SHL-1 (2026-10-31): the person's own Telegram id, so the "no
     * access" screens can show who is signed in and what to send the
     * administrator. Optional: sessions saved by older builds lack it.
     */
    tgUserId: z.string().nullable().optional(),
  }),
  member: MemberSummarySchema,
  /** Active organisations this user belongs to. */
  memberships: z.array(OrganizationMembershipSchema).default([]),
  /** Cross-tenant operator. Only these users may create new tenants. */
  isPlatformAdmin: z.boolean().default(false),
  subscription: SubscriptionSummarySchema,
  /** ONLY the stores this member is assigned to (admins see all org stores). */
  stores: z.array(StoreSummarySchema),
  permissions: z.array(z.string()),
  roleSlugs: z.array(z.string()),
  /** Highest role rank the actor holds. UI uses this to filter role
   *  grant choices — an admin (80) only sees roles ranked < 80 in the
   *  grant picker so they can't even offer admin/super_admin. The
   *  server enforces the same gate on the actual mutation. */
  myMaxRank: z.number().int().nonnegative().default(0),
  /** Per-store max rank from store-scoped role bindings only (added
   *  2026-05-06 for C1). Used by the FE to filter the grant-role
   *  picker per target store: a manager-rank-50-of-A can only see
   *  roles ranked < 50 when granting INTO Store A. The server
   *  enforces with `getActorMaxRankInStore`. */
  storeRanks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Stores in which the actor has admin-tier permission (users.manage,
   *  users.invite, or users.grant_role) — added 2026-05-06 for C2.
   *  - global admin → every active store id in the org
   *  - store-scoped admin → only those stores
   *  - non-admin → empty array
   *  FE filters the invite store picker, the grant-role store picker,
   *  and the assign/unassign actions against this set. The server
   *  enforces with `getActorAdminStoreIds`. */
  adminStoreIds: z.array(UuidSchema).default([]),
  /** SHL-2 / CLS-5 (2026-10-30): effective permission keys per store the
   *  member is in (roles + overrides at that store, plus global ones).
   *  `permissions` remains the flat union. */
  storePermissions: z.record(z.string(), z.array(z.string())).default({}),
  /** True until the user confirms their name in onboarding. */
  needsOnboarding: z.boolean(),
});

export const CompleteOnboardingInputSchema = z.object({
  // AUTH-4: trim first, or "   " passes min(1) and locks an empty name.
  // F10: no control characters (names reach the operator's terminal).
  displayName: z.string().trim().min(1).max(200).refine(noControlChars, CONTROL_CHARS_MESSAGE),
});

export const SwitchOrganizationInputSchema = z.object({
  orgId: UuidSchema,
});

export const CreateOrganizationInputSchema = z.object({
  name: z.string().trim().min(2).max(200).refine(noControlChars, CONTROL_CHARS_MESSAGE),
  /** Optional operator-chosen slug; omitted lets the server derive one. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'slug must use lowercase letters, digits and hyphens')
    .optional(),
  locale: LocaleSchema.optional(),
  timezone: TimeZoneSchema.optional(),
});

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessExpiresAt: z.string(),
  refreshExpiresAt: z.string(),
});

export const LoginOutputSchema = z.object({
  tokens: AuthTokensSchema,
  session: SessionSchema,
});
