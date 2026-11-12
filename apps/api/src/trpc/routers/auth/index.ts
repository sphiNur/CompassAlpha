/**
 * The auth router: signing in (Telegram, an invite link, and the
 * development and staging paths), refreshing, moving to or creating an
 * organisation, and the signed-in person's own session.
 *
 * Review COREAPI-09 (2026-11-12): this was one file of 1,900 lines. Each
 * part has its own file now and the router spreads them, so every path
 * stays `auth.<name>`: the web, the Fine app and the smokes did not
 * change. The session the client receives is built in
 * services/sessionPayload.ts.
 */
import { router } from '../../trpc';
import { accountProcedures } from './account';
import { devLoginProcedures } from './dev';
import { inviteProcedures } from './invite';
import { loginModeProcedures } from './modes';
import { nonTelegramProcedures } from './nonTelegram';
import { organizationProcedures } from './organizations';
import { refreshProcedures } from './refresh';
import { telegramProcedures } from './telegram';

export const authRouter = router({
  ...loginModeProcedures,
  ...devLoginProcedures,
  ...nonTelegramProcedures,
  ...telegramProcedures,
  ...inviteProcedures,
  ...organizationProcedures,
  ...accountProcedures,
  ...refreshProcedures,
});
