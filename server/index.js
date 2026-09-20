require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const { createBot } = require('./bot');
const { verifyInitData } = require('./verifyTelegram');
const store = require('./store');

const {
  BOT_TOKEN,
  WEBAPP_URL,
  PORT = 3000,
  MONETAG_ZONE_ID = '',
  ADSGRAM_BLOCK_ID = '',
  AD_PROVIDER = '', // optional manual override: 'monetag' or 'adsgram'
  REWARD_PER_AD = 10,
  MAX_ADS_PER_DAY = 20,
  MIN_SECONDS_BETWEEN_ADS = 30,
  ADMIN_KEY = '',
} = process.env;

let botUsername = null; // filled in once the bot connects, used to build referral links

// Pick which ad network to use. An explicit AD_PROVIDER wins; otherwise
// whichever provider has an ID set wins, Adsgram first (arbitrary but
// consistent — change this order if you'd rather default the other way).
function resolveAdProvider() {
  if (AD_PROVIDER === 'monetag' || AD_PROVIDER === 'adsgram') return AD_PROVIDER;
  if (ADSGRAM_BLOCK_ID) return 'adsgram';
  if (MONETAG_ZONE_ID) return 'monetag';
  return null;
}

if (!BOT_TOKEN || BOT_TOKEN.includes('AAExampleTokenReplaceMe')) {
  console.warn(
    '\n⚠️  No real BOT_TOKEN set in .env — the Telegram bot will not start.\n' +
      '   The web app will still run so you can test the UI in a browser.\n'
  );
}

const app = express();
app.use(cors());
app.use(express.json());
// Never let the browser or Telegram's WebView cache the app's own files —
// otherwise every future update needs a manual cache-clear to actually
// show up, which isn't obvious and easy to mistake for a broken deploy.
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    },
  })
);

// Tell the frontend whether real ads are configured yet, without exposing secrets.
app.get('/api/config', (_req, res) => {
  // These IDs are embedded in public client-side script tags by design
  // (both networks put them directly in the HTML) — not secrets, unlike
  // the bot token.
  res.json({
    adProvider: resolveAdProvider(),
    adsConfigured: Boolean(resolveAdProvider()),
    monetagZoneId: MONETAG_ZONE_ID || null,
    adsgramBlockId: ADSGRAM_BLOCK_ID || null,
    rewardPerAd: Number(REWARD_PER_AD),
    botUsername, // null until the bot has connected once
  });
});

// Called once, when the Mini App opens, to identify/create the user.
app.post('/api/session', async (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'invalid_telegram_data' });

  // Referrals are recorded exclusively in bot.js's /start handler — the
  // only event we can trust, since Telegram itself invokes it with the
  // user's real id. Anything in a request body can be typed by hand, so
  // this route never accepts or sets a referrer, even for brand-new users.
  const record = await store.getOrCreateUser(user.id, user.first_name || user.username);
  res.json(publicUser(record));
});

// Called after the ad SDK's Promise resolves (ad genuinely watched).
app.post('/api/watch-complete', async (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'invalid_telegram_data' });

  const result = await store.creditAdReward(user.id, Number(REWARD_PER_AD), {
    maxPerDay: Number(MAX_ADS_PER_DAY),
    minSecondsBetween: Number(MIN_SECONDS_BETWEEN_ADS),
  });

  if (!result.ok) return res.status(429).json(result);
  res.json(publicUser(result.user));
});

app.get('/api/leaderboard', async (_req, res) => {
  res.json(await store.getLeaderboard(10));
});

app.post('/api/referral-status', async (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'invalid_telegram_data' });

  const status = await store.getReferralStatus(user.id);
  if (!status) return res.status(404).json({ error: 'unknown_user' });
  res.json(status);
});

app.post('/api/withdraw-request', async (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'invalid_telegram_data' });

  const result = await store.requestWithdrawal(user.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result.request);
});

// Simple key check — fine for a school project demo, not real auth.
// The key never touches the client except when the admin types it in.
app.get('/api/admin/stats', async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin_key_not_set' });
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });

  res.json({
    stats: await store.getStats(),
    leaderboard: await store.getLeaderboard(10),
    recentEvents: await store.getRecentEvents(20),
    withdrawalRequests: await store.listWithdrawalRequests(),
  });
});

app.post('/api/admin/withdrawals/:id/status', async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin_key_not_set' });
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });

  const { status } = req.body || {};
  if (!['paid', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }

  const updated = await store.setWithdrawalStatus(req.params.id, status);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  res.json(updated);
});

function resolveUser(req) {
  // Real Telegram launch: verify the signed initData.
  const initData = req.headers['x-telegram-init-data'];
  if (initData) return verifyInitData(initData, BOT_TOKEN);

  // Dev fallback so you can test in a plain browser tab (not inside Telegram).
  if (process.env.NODE_ENV !== 'production' && req.body?.devUserId) {
    return { id: String(req.body.devUserId), first_name: `DevUser${req.body.devUserId}` };
  }
  return null;
}

function publicUser(u) {
  return {
    name: u.name,
    balance: u.balance,
    adsWatchedToday: u.adsWatchedToday,
    adsWatchedTotal: u.adsWatchedTotal,
    history: u.history,
  };
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

if (BOT_TOKEN && !BOT_TOKEN.includes('AAExampleTokenReplaceMe')) {
  const bot = createBot({ token: BOT_TOKEN, webAppUrl: WEBAPP_URL });
  bot.telegram
    .getMe()
    .then((me) => {
      botUsername = me.username;
    })
    .catch(() => {
      console.warn('Could not fetch bot username — referral links will be unavailable until it does.');
    });
  bot.launch();
  console.log('Telegram bot started (polling).');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
