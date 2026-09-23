require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
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
  TADS_WIDGET_ID = '',
  TADS_WEBHOOK_SECRET = '',
} = process.env;

let botUsername = null; // filled in once the bot connects, used to build referral links
let bot = null;

// Polling (bot.launch(), what this app used before) only allows ONE process
// to poll Telegram at a time — a second instance (even briefly, during a
// deploy restart) gets a 409 Conflict and crashes, which is exactly what
// took down a real deploy earlier. Webhook mode has no such limit: Telegram
// pushes updates to a URL we register instead, so it scales normally.
//
// The path includes a hash of the bot token rather than a fixed name, so
// it's not guessable by anyone scanning for common webhook URLs — without
// needing yet another secret env var to manage.
const WEBHOOK_PATH = BOT_TOKEN
  ? `/telegram-webhook/${crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32)}`
  : null;

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
// Render (and most hosts) put your app behind a reverse proxy. Without this,
// every request looks like it comes from the proxy's own IP, which would
// make per-IP rate limiting below useless — it'd lump every real user
// together as "one IP" instead of telling them apart.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Lightweight in-memory rate limiter — no new npm dependency needed. Good
// enough for a single Render instance; if this app ever runs on multiple
// instances behind a load balancer, these counts would need to move into
// Redis (like the write-lock above) to stay accurate across all of them.
function rateLimiter({ windowMs, max, keyFn }) {
  const hits = new Map(); // key -> { count, resetAt }

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits.entries()) if (now > entry.resetAt) hits.delete(key);
  }, 60_000).unref();

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

// General safety net across every API route — generous enough not to
// bother a real user, tight enough to blunt a flooding script. If your
// stress test sends all 100k simulated users' traffic from one source IP
// (rather than many distinct IPs), raise this number accordingly, since
// otherwise the test harness itself would look like a single abusive
// client and start getting 429s.
app.use('/api/', rateLimiter({ windowMs: 60_000, max: 300, keyFn: (req) => req.ip }));

// Tighter limit specifically on the Tads webhook, keyed by telegram_id
// rather than IP — Tads calls this from its own servers, so IP-based
// limiting would either be meaningless (shared IP for all users) or risk
// blocking Tads' legitimate traffic entirely. Per-telegram_id catches a
// leaked ?key= secret being replayed rapidly for one user, while leaving
// store.creditAdReward's existing per-user cooldown as the real backstop.
const tadsWebhookLimiter = rateLimiter({
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => `tads:${req.query.telegram_id || req.body?.telegram_id || req.ip}`,
});

if (BOT_TOKEN && !BOT_TOKEN.includes('AAExampleTokenReplaceMe')) {
  bot = createBot({ token: BOT_TOKEN, webAppUrl: WEBAPP_URL });
  app.use(bot.webhookCallback(WEBHOOK_PATH));
}

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
    // Tads isn't picked by resolveAdProvider() — it's a fallback network
    // the frontend tries whenever the primary provider above has no ad,
    // not a competing "which one is primary" choice.
    tadsWidgetId: TADS_WIDGET_ID || null,
    rewardPerAd: Number(REWARD_PER_AD),
    botUsername, // null until the bot has connected once
  });
});

// Wraps a route handler so a thrown error (e.g. store_lock_timeout under
// heavy concurrent load) returns a clean 503 instead of hanging the
// request or relying solely on the process-wide safety net above.
function asyncRoute(fn) {
  return (req, res) => {
    fn(req, res).catch((err) => {
      console.error(`[route error] ${req.method} ${req.path}:`, err?.message || err);
      if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
    });
  };
}

// Called once, when the Mini App opens, to identify/create the user.
app.post('/api/session', asyncRoute(async (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'invalid_telegram_data' });

  // Referrals are recorded exclusively in bot.js's /start handler — the
  // only event we can trust, since Telegram itself invokes it with the
  // user's real id. Anything in a request body can be typed by hand, so
  // this route never accepts or sets a referrer, even for brand-new users.
  const record = await store.getOrCreateUser(user.id, user.first_name || user.username);
  res.json(publicUser(record));
}));

// Called after the ad SDK's Promise resolves (ad genuinely watched).
app.post('/api/watch-complete', asyncRoute(async (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'invalid_telegram_data' });

  const result = await store.creditAdReward(user.id, Number(REWARD_PER_AD), {
    maxPerDay: Number(MAX_ADS_PER_DAY),
    minSecondsBetween: Number(MIN_SECONDS_BETWEEN_ADS),
  });

  if (!result.ok) return res.status(429).json(result);
  res.json(publicUser(result.user));
}));

// Server-to-server postback from Tads (https://tads.me), configured as the
// widget's "Webhook URL". Tads calls this itself — no browser involved —
// when a user watches (Fullscreen widgets) or clicks (TGB widgets) an ad.
// Docs: https://docs.tads.me/getting-started/publishers/webhooks
//
// Tads sends { telegram_id, widget_id } as GET query params or a POST body,
// depending on which method you pick in the widget form. It does not sign
// or authenticate these requests, so this route requires its own shared
// secret (?key=...) appended to the Webhook URL you paste into Tads — set
// TADS_WEBHOOK_SECRET below to whatever you put in that query param.
app.all('/api/tads-webhook', tadsWebhookLimiter, asyncRoute(async (req, res) => {
  const params = { ...req.query, ...(req.body || {}) };
  const { telegram_id: telegramId, widget_id: widgetId, key } = params;

  // Reject anyone who doesn't know the secret — without this, anyone who
  // finds this URL could credit themselves unlimited balance.
  if (!TADS_WEBHOOK_SECRET || key !== TADS_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!telegramId) return res.status(400).json({ error: 'missing_telegram_id' });

  // Optional extra check: only accept postbacks for the widget you expect,
  // in case you ever add a second widget with its own webhook later.
  if (TADS_WIDGET_ID && String(widgetId) !== String(TADS_WIDGET_ID)) {
    return res.status(400).json({ error: 'unexpected_widget_id' });
  }

  // Tads only tells us the user exists — it doesn't know their name, so
  // this never creates a brand-new user; they must have opened the Mini
  // App at least once already (which is when getOrCreateUser first runs).
  const user = await store.getUser(String(telegramId));
  if (!user) return res.status(404).json({ error: 'unknown_user' });

  const result = await store.creditAdReward(String(telegramId), Number(REWARD_PER_AD), {
    maxPerDay: Number(MAX_ADS_PER_DAY),
    minSecondsBetween: Number(MIN_SECONDS_BETWEEN_ADS),
  });

  // Respond 200 either way — Tads just needs an ack that the postback was
  // received, and a 429 here would likely just trigger their own retries.
  if (!result.ok) return res.status(200).json(result);
  res.status(200).json({ ok: true });
}));

app.get('/api/leaderboard', async (_req, res) => {
  res.json(await store.getLeaderboard(10));
});

app.post('/api/referral-status', asyncRoute(async (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'invalid_telegram_data' });

  const status = await store.getReferralStatus(user.id);
  if (!status) return res.status(404).json({ error: 'unknown_user' });
  res.json(status);
}));

app.post('/api/withdraw-request', asyncRoute(async (req, res) => {
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: 'invalid_telegram_data' });

  const result = await store.requestWithdrawal(user.id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result.request);
}));

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

// Manually create or edit a user's balance/name — for correcting a bug,
// compensating someone, or adding an entry you control directly. Creates
// the user if the id doesn't already exist.
app.post('/api/admin/users/:id', async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin_key_not_set' });
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });

  const { name, balance } = req.body || {};
  if (balance !== undefined && !Number.isFinite(Number(balance))) {
    return res.status(400).json({ error: 'invalid_balance' });
  }

  const updated = await store.adminSetUser(req.params.id, { name, balance });
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

// Without these, ANY uncaught error anywhere — a bad ad-network response, a
// Redis hiccup, the Telegram polling conflict that crashed a real deploy —
// takes down the entire process, disconnecting every one of your users at
// once. Logging and continuing is far safer than crashing at real scale.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] server kept running:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] server kept running:', reason);
});

if (bot) {
  bot.telegram
    .getMe()
    .then((me) => {
      botUsername = me.username;
    })
    .catch(() => {
      console.warn('Could not fetch bot username — referral links will be unavailable until it does.');
    });

  if (WEBAPP_URL) {
    // Tell Telegram to start pushing updates to our route instead of us
    // polling for them. Safe to call on every restart — Telegram just
    // re-confirms the same URL if it's unchanged.
    bot.telegram
      .setWebhook(`${WEBAPP_URL}${WEBHOOK_PATH}`)
      .then(() => console.log('Telegram bot ready (webhook mode).'))
      .catch((err) => console.error('[bot] setWebhook failed, web app is still running:', err?.message || err));
  } else {
    console.warn('WEBAPP_URL is not set — cannot register the Telegram webhook.');
  }
}
