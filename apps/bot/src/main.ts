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

bot.command('start', (ctx) => ctx.reply('Welcome to Compass. Open the Mini App to continue.'));

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
