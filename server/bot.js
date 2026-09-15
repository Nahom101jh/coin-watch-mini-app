const { Telegraf, Markup } = require('telegraf');

function createBot({ token, webAppUrl }) {
  const bot = new Telegraf(token);

  bot.start((ctx) => {
    const ref = ctx.startPayload; // set when opened via a referral deep link
    const url = ref ? `${webAppUrl}?ref=${encodeURIComponent(ref)}` : webAppUrl;

    ctx.reply(
      `Welcome, ${ctx.from.first_name}! 👋\n\n` +
        `Watch short ads and earn points. Tap below to open the app.`,
      Markup.inlineKeyboard([Markup.button.webApp('🪙 Open Rewards App', url)])
    );
  });

  bot.help((ctx) =>
    ctx.reply('Tap /start to open the rewards app. Watch an ad, earn points, check the leaderboard.')
  );

  return bot;
}

module.exports = { createBot };
