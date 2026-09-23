const { Telegraf, Markup } = require('telegraf');
const store = require('./store');

function createBot({ token, webAppUrl }) {
  const bot = new Telegraf(token);

  // Without this, an error thrown while handling any single user's message
  // (e.g. a Redis hiccup during getOrCreateUser) becomes an unhandled
  // rejection that can crash the whole server for all 100k users, not just
  // fail that one /start command.
  bot.catch((err, ctx) => {
    console.error(`[bot] error handling update ${ctx.updateType}:`, err);
  });

  bot.start(async (ctx) => {
    const userId = String(ctx.from.id);
    const ref = ctx.startPayload || null; // set when opened via a referral deep link

    // This is the ONLY place a referral gets recorded. Telegram itself is
    // invoking this handler with ctx.from's real, authenticated id — unlike
    // a query string on the web app's URL, this can't be typed by hand.
    await store.getOrCreateUser(userId, ctx.from.first_name, ref);

    ctx.reply(
      `Welcome, ${ctx.from.first_name}! 👋\n\n` +
        `Watch short ads and earn points. Tap below to open the app.`,
      Markup.inlineKeyboard([Markup.button.webApp('🪙 Open Rewards App', webAppUrl)])
    );
  });

  bot.help((ctx) =>
    ctx.reply('Tap /start to open the rewards app. Watch an ad, earn points, check the leaderboard.')
  );

  return bot;
}

module.exports = { createBot };
