/**
 * The signed-in person's own session: reading it, confirming their name
 * once, their two languages, and signing out everywhere.
 */
import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import { inSystem, schema as s } from '@compass/db';
import {
  CompleteOnboardingInputSchema,
  SetLocaleInputSchema,
  SetSecondaryLocaleInputSchema,
} from '@compass/contracts';
import { authedProcedure } from '../../trpc';
import { revokeAllForUser } from '../../../services/refreshTokens';
import { buildSessionPayload } from '../../../services/sessionPayload';

export const accountProcedures = {
  /** Get current session — used by AuthGate. */
  me: authedProcedure.query(async ({ ctx }) => {
    return buildSessionPayload(ctx.db, ctx.session.userId, ctx.session.memberId, ctx.session.orgId);
  }),

  /**
   * One-shot onboarding: user confirms (or rewrites) their displayName,
   * we lock it. After this, only an admin can rename the user via
   * `admin.memberSetDisplayName`. Idempotent — calling twice with the
   * same name is a no-op.
   *
   * Why locked: it prevents staff from impersonating coworkers by
   * suddenly renaming themselves to a manager's name. Names appear in
   * the approval queue, run cockpit, audit log — they need to be stable
   * enough that "@张三" means the same person across contexts.
   */
  completeOnboarding: authedProcedure
    .input(CompleteOnboardingInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await inSystem(ctx.db, 'auth', (tx) =>
        tx.query.users.findFirst({
          where: (u, { eq: eq2 }) => eq2(u.id, ctx.session.userId),
        }),
      );
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'auth.errors.userMissing' });
      }
      // Allow re-running for the same name (no-op) so a flaky network
      // retry doesn't surface as an error.
      if (user.displayNameLocked && user.displayName === input.displayName) {
        return buildSessionPayload(
          ctx.db,
          ctx.session.userId,
          ctx.session.memberId,
          ctx.session.orgId,
        );
      }
      // Hard rule: once locked, a user cannot rename themselves.
      if (user.displayNameLocked) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'auth.errors.nameLocked',
        });
      }
      await inSystem(ctx.db, 'auth', (tx) =>
        tx
          .update(s.users)
          .set({
            displayName: input.displayName,
            displayNameLocked: true,
            updatedAt: new Date(),
          })
          .where(eq(s.users.id, ctx.session.userId)),
      );
      return buildSessionPayload(
        ctx.db,
        ctx.session.userId,
        ctx.session.memberId,
        ctx.session.orgId,
      );
    }),

  /**
   * User-controlled language override (added 2026-05-05).
   *
   * Telegram exposes `initDataUnsafe.user.language_code` which gives a
   * decent first guess (matches the user's Telegram UI language), but
   * staff often work in mixed-language teams — a Russian-speaking
   * cashier in an Uzbek restaurant may have Telegram set to ru while
   * preferring uz/zh in this app, or vice versa. This mutation lets
   * them pin their preference; the FE reads it back via `auth.me`
   * and `useI18n` resolves it before falling back to Telegram locale.
   *
   * Persists to `auth.users.locale`. The 4 valid codes match the
   * 4-language SKU contract — anything else is rejected.
   */
  setLocale: authedProcedure.input(SetLocaleInputSchema).mutation(async ({ ctx, input }) => {
    await inSystem(ctx.db, 'auth', (tx) =>
      tx
        .update(s.users)
        .set({
          locale: input.locale,
          // AUTH-14 (2026-10-30): a second language equal to the new
          // primary one left no stall-language row selected (not even
          // "off"); it adds nothing, so it is cleared.
          secondaryLocale: sql`CASE WHEN ${s.users.secondaryLocale} = ${input.locale} THEN NULL ELSE ${s.users.secondaryLocale} END`,
          updatedAt: new Date(),
        })
        .where(eq(s.users.id, ctx.session.userId)),
    );
    return buildSessionPayload(ctx.db, ctx.session.userId, ctx.session.memberId, ctx.session.orgId);
  }),

  /**
   * M3.45 (2026-05-22): set the user's secondary display language. When
   * set, product names in the UI render as "Primary (Secondary)" and
   * per-vendor copy templates use the secondary locale exclusively (so
   * a Chinese-speaking purchaser can paste a Uzbek list straight into
   * the vendor's chat). Passing `null` clears it (single-language UI,
   * the default).
   *
   * Same enum as setLocale — anything outside the 4-locale contract
   * gets rejected at the input boundary.
   */
  setSecondaryLocale: authedProcedure
    .input(SetSecondaryLocaleInputSchema)
    .mutation(async ({ ctx, input }) => {
      await inSystem(ctx.db, 'auth', (tx) =>
        tx
          .update(s.users)
          .set({ secondaryLocale: input.secondaryLocale, updatedAt: new Date() })
          .where(eq(s.users.id, ctx.session.userId)),
      );
      return buildSessionPayload(
        ctx.db,
        ctx.session.userId,
        ctx.session.memberId,
        ctx.session.orgId,
      );
    }),

  /**
   * Sign out from EVERY device. M1.9 (2026-05-07): finally does
   * something — revokes all of the user's tracked refresh tokens.
   * Access tokens themselves are stateless (15-min TTL) so they can
   * still verify until expiry; the security improvement is that
   * silent re-login via refresh is now impossible.
   *
   * Per-device sign-out (revoke just this family) would need the
   * client to pass the refresh token. We deliberately default to
   * "everywhere" because the most common signout reason is "phone
   * stolen / left at the restaurant" — losing one device's session
   * shouldn't leave others authenticated.
   */
  signOut: authedProcedure.mutation(async ({ ctx }) => {
    const revoked = await revokeAllForUser(ctx.db, ctx.session.userId);
    return { ok: true, revoked };
  }),
};
