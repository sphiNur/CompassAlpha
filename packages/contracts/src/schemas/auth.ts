import { z } from 'zod';
import { LocaleSchema, UuidSchema } from './common';

export const TelegramLoginInputSchema = z.object({
  initData: z.string().min(1),
  /** Optional locale override; otherwise we use Telegram's user.language_code. */
  locale: LocaleSchema.optional(),
});

export const RefreshInputSchema = z.object({
  refreshToken: z.string().min(20).max(200),
});

export const StoreSummarySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  code: z.string().nullable(),
  isActive: z.boolean(),
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
  }),
  member: MemberSummarySchema,
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
  /** True until the user confirms their name in onboarding. */
  needsOnboarding: z.boolean(),
});

export const CompleteOnboardingInputSchema = z.object({
  displayName: z.string().min(1).max(200).trim(),
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
