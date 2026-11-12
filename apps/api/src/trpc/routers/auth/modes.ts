/**
 * Which ways of signing in this server offers, and the two queries that
 * tell the client. Telegram always; the local developer mock and the
 * browser login for remote checks only where the server's switches allow
 * them.
 */
import { env } from '../../../env';
import { isLocalDevPeer } from '../../../services/devLocality';
import type { TelegramUser } from '../../../services/telegramAuth';
import { publicProcedure } from '../../trpc';
import type { RequestContext } from '../../context';

export function releaseChannel(): 'development' | 'staging' | 'production' {
  return (
    env.COMPASS_RELEASE_CHANNEL ?? (env.NODE_ENV === 'production' ? 'production' : 'development')
  );
}

export function parseNonTelegramUsers(): Map<string, string> {
  const raw = env.NON_TELEGRAM_LOGIN_USERS;
  const users = new Map<string, string>();
  if (!raw) return users;

  for (const entry of raw.split(/[,\n;]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 1) continue;

    const tgUserId = trimmed.slice(0, separator).trim();
    const accessCode = trimmed.slice(separator + 1).trim();
    if (!/^\d{4,20}$/.test(tgUserId)) continue;
    if (accessCode.length < 16) continue;
    users.set(tgUserId, accessCode);
  }
  return users;
}

export function isNonTelegramLoginAvailable(): boolean {
  if (env.NON_TELEGRAM_LOGIN_ENABLED !== 'true') return false;
  if (releaseChannel() === 'production') return false;
  return parseNonTelegramUsers().size > 0;
}

export const DEV_MOCK_INIT_DATA = '1';
export const DEV_MOCK_TG_USER: TelegramUser = {
  id: 9_000_000_001,
  first_name: 'Local Developer',
  username: 'compass_local_dev',
  language_code: 'en',
};

/**
 * Browser automation needs a real authenticated session so it can exercise
 * the same tRPC, permission, and realtime paths as Telegram. This route is
 * intentionally narrower than the diagnostic browser login above:
 *
 * - only the literal local mock initData value is accepted;
 * - the server must opt in with DEV_MOCK_LOGIN_ENABLED=true;
 * - both NODE_ENV and release channel must be development;
 * - production release builds cannot carry VITE_DEV_MOCK_INIT_DATA.
 *
 * The identity is created and elevated only in the local seeded database.
 * It is never available to staging or production data.
 */
export function isDevMockLoginAvailable(): boolean {
  return (
    env.DEV_MOCK_LOGIN_ENABLED === 'true' &&
    env.NODE_ENV === 'development' &&
    releaseChannel() === 'development'
  );
}

/** D21: only a direct connection from this machine or the LAN (services/devLocality.ts). */
function isLocalDevRequest(ctx: RequestContext): boolean {
  return isLocalDevPeer(ctx.peerIp, (name) => ctx.hono.req.header(name));
}

export function devLoginUnavailableReason(ctx: RequestContext): string | null {
  if (!isDevMockLoginAvailable()) return 'auth.errors.devBypassDisabled';
  if (!isLocalDevRequest(ctx)) return 'auth.errors.devLocalhostOnly';
  return null;
}

function nonTelegramUnavailableReason(): string | null {
  if (env.NON_TELEGRAM_LOGIN_ENABLED !== 'true') {
    return 'auth.errors.nonTelegramLoginDisabled';
  }
  if (releaseChannel() === 'production') {
    return 'auth.errors.nonTelegramProductionDisabled';
  }
  if (parseNonTelegramUsers().size === 0) {
    return 'auth.errors.nonTelegramAllowlistEmpty';
  }
  return null;
}

export const loginModeProcedures = {
  loginModes: publicProcedure.query(({ ctx }) => {
    const devReason = devLoginUnavailableReason(ctx);
    const nonTelegramReason = nonTelegramUnavailableReason();
    return {
      environment: {
        nodeEnv: env.NODE_ENV,
        releaseChannel: releaseChannel(),
        localRequest: isLocalDevRequest(ctx),
      },
      telegram: {
        available: true,
        hasBotToken: Boolean(env.TELEGRAM_BOT_TOKEN),
        requiresInitData: true,
      },
      devPersona: {
        available: devReason === null,
        enabled: env.DEV_MOCK_LOGIN_ENABLED === 'true',
        reason: devReason,
      },
      nonTelegram: {
        available: nonTelegramReason === null,
        enabled: env.NON_TELEGRAM_LOGIN_ENABLED === 'true',
        reason: nonTelegramReason,
      },
    };
  }),

  nonTelegramStatus: publicProcedure.query(() => ({
    enabled: isNonTelegramLoginAvailable(),
  })),
};
