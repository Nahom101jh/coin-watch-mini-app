const { Telegraf, Markup } = require('telegraf');
const store = require('./store');

function createBot({ token, webAppUrl }) {
  const bot = new Telegraf(token);

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
