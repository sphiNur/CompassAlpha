/**
 * Compass Telegram bot — M2 deliverable.
 *
 * For M0 we ship the entry point + grammY bootstrap so the deploy topology
 * is real (process exists, healthcheck wired). The notification dispatcher
 * lands when the outbox worker is implemented.
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

bot.start({
  onStart(info) {
    console.log('[bot] started @' + info.username);
  },
});
