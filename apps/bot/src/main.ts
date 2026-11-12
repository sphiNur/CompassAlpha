/**
 * Compass Telegram bot: answers /start (with an invite fallback) and /id
 * by long polling. It sends no notifications; the outbox worker
 * (apps/worker) delivers those through the Bot API relay.
 *
 * Run with: TELEGRAM_BOT_TOKEN=... bun run src/main.ts
 */
import { Bot } from 'grammy';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('[bot] TELEGRAM_BOT_TOKEN not set; refusing to start');
  process.exit(1);
}

const bot = new Bot(token);

bot.command('start', (ctx) => {
  const inviteToken = ctx.match.trim();
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, '');
  if (inviteToken.startsWith('inv_') && frontendUrl?.startsWith('https://')) {
    // Fallback for clients where the invite was sent as a plain
    // /start payload rather than a ?startapp= deep link. The button
    // opens the same Mini App with initData, so acceptance still
    // happens through the normal signed-in path.
    return ctx.reply('Open Compass to accept your invitation.', {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Accept invitation',
              web_app: {
                url: `${frontendUrl}/?invite=${encodeURIComponent(inviteToken)}`,
              },
            },
          ],
        ],
      },
    });
  }
  return ctx.reply('Welcome to Compass. Open the Mini App to continue.');
});

bot.command('id', (ctx) =>
  ctx.reply(
    `Your Telegram user id: ${ctx.from?.id ?? '(unknown)'}\nShare this with your administrator to be granted access.`,
  ),
);

bot.catch((err) => console.error('[bot] error', err));

// start() settles when polling stops; a rejection (a revoked token, say)
// ends the process with the reason instead of an unhandled rejection.
bot
  .start({
    onStart(info) {
      console.log('[bot] started @' + info.username);
    },
  })
  .catch((err) => {
    console.error('[bot] polling stopped', err);
    process.exit(1);
  });
