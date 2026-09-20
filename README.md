# Coin Watch — watch ads, earn points (Telegram Mini App)

A Telegram bot + Mini App where users watch real rewarded ads and earn demo
points. The **ad revenue is real** (it goes to your ad network account as the
app owner/admin); the **user reward is a demo currency**, tracked in a simple
local database — which is exactly right for a school project, since paying
out real money would require handling real payments, KYC, and compliance.

## Switching ad networks (Monetag / Adsgram)

The app supports either network through the same code — nothing to rewrite.
Set the ID for whichever one you're using in `.env`:

```
MONETAG_ZONE_ID=11763151
ADSGRAM_BLOCK_ID=47915
```

If both are set, Adsgram is used by default. To force a specific one
regardless of what IDs are set, add:

```
AD_PROVIDER=monetag
```
(or `adsgram`). Restart the server after changing any of these.

## Persistent storage (important on free hosting)

All user data — balances, referrals, withdrawal requests — lives in
[Upstash](https://upstash.com), a free Redis database, not a local file.

**Why this matters:** free hosts like Render's free tier don't guarantee
your app's local disk survives a restart. Every time the container sleeps
and wakes back up (or redeploys for any reason, including changing an
environment variable), it starts from the exact code in your GitHub repo —
and a locally-written file isn't part of that. A plain `data.json` file
would get silently wiped on every single restart, which is exactly what
happened during development before this was fixed: watching an ad and
earning points, then having a routine restart erase it back to zero.

**Setup:**

1. Sign up free at [upstash.com](https://upstash.com), create a Redis
   database (any region is fine).
2. From its dashboard, copy the **REST URL** and **REST TOKEN**.
3. Add them to `.env` (and to Render's Environment tab, if deployed):

```
UPSTASH_REDIS_REST_URL=https://your-db-name.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
```

4. Restart the server. That's it — `server/store.js` handles everything
   else identically to before; only *where* the data lives changed, not
   how any of the app's logic works.

The free tier (500K commands/month, 256MB storage) is far more than a
class project needs.

## How it fits together

```
Telegram user
   │  taps "Open App" in the bot
   ▼
Mini App (public/) ── runs inside Telegram, shown as a normal web page
   │  clicks "Watch an ad"
   ▼
Monetag ad SDK ── shows a real rewarded video ad, resolves a Promise on completion
   │
   ▼
Your server (server/) ── verifies the request really came from Telegram,
                          credits demo points, enforces daily/cooldown limits
```

## 1. Create your bot

1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, follow the prompts, and copy the token it gives you.
3. Put it in `.env` as `BOT_TOKEN`.

## 2. Get a real ad network account (for the admin-side revenue)

[Monetag](https://monetag.com) is the option this project is wired for — it's
built specifically for Telegram Mini Apps and has no minimum traffic
requirement to get started.

1. Sign up, add your Mini App.
2. Create a **Rewarded Interstitial** zone and copy its zone ID.
3. Put it in `.env` as `MONETAG_ZONE_ID`.

Until you add a real zone ID, the app runs in a "no ads configured" state —
so you can build and demo the rest without an ad account yet.

## 3. Run it locally

```bash
npm install
cp .env.example .env   # then fill in BOT_TOKEN (and MONETAG_ZONE_ID when ready)
npm start
```

This starts the web server (default `http://localhost:3000`) and the bot.

## 4. Expose it over HTTPS (Telegram requires this)

Telegram Mini Apps must be served over HTTPS, even in development. Easiest
option is a tunnel:

```bash
npx ngrok http 3000
```

Copy the `https://...ngrok...` URL it gives you into `.env` as `WEBAPP_URL`,
then restart `npm start`.

## 5. Register the Mini App URL with BotFather

1. Message **@BotFather** → `/mybots` → your bot → **Bot Settings** →
   **Menu Button** (or `/newapp` for a full Mini App listing).
2. Paste your `WEBAPP_URL`.
3. Open your bot in Telegram, send `/start`, tap the button — the app opens.

## 6. Deploying for real (beyond localhost/ngrok)

Any Node host works (Railway, Render, Fly.io, a school server). Set the same
`.env` values there, and point `WEBAPP_URL` / BotFather at that host's URL
instead of the ngrok one.

## Where the "admin gets paid, user gets a demo reward" logic lives

- **Real ad revenue**: happens entirely on Monetag's side, tied to your
  `MONETAG_ZONE_ID` / dashboard account — nothing in this code touches money.
- **Demo user reward**: `server/store.js` → `creditAdReward()`. It's plain
  points, stored in Upstash Redis (`server/store.js`). Free-tier hosts like
  Render wipe local files on every restart, so this data deliberately lives
  outside the app's own filesystem — see "Persistent storage" below.

To swap points for something real later (Telegram Stars, a gift-card API,
etc.), that function is the one place you'd change.

## A note on doing this properly (worth knowing, not just for grading)

Right now the reward is credited as soon as the browser's `.then()` fires —
fine for a demo, but in production someone could fake that by editing the
page's JavaScript. The correct way for a real payout system is a **server-to-
server postback**: Monetag calls *your server* directly when an ad genuinely
completes, and only that call credits the reward. Monetag's docs cover this
under "postback URL" / `ymid` — worth reading if this project grows past a
demo.

## Referrals and withdrawal

Users unlock a "Request Withdrawal" button by inviting friends:

- Each user gets a personal invite link (`t.me/YourBot?start=<their id>`) shown
  in the Withdraw tab.
- When someone opens the bot through that link, `bot.js` reads the referral
  code from `/start` and links the new user to their inviter right there
  (`server/store.js` → `getOrCreateUser`). This is the *only* place a
  referral is ever recorded — Telegram itself invokes this handler with the
  user's real, authenticated id, unlike a web request body, which anyone
  can fabricate by hand. Earlier versions accepted a `?ref=` query string on
  the web app's own URL, which meant anyone could grant themselves fake
  invites by typing a URL — that path has been removed entirely.

  **Testing this yourself:** since referrals now only count through a real
  `/start` deep link, you can't fake a second "friend" by opening the web
  URL directly with a `?ref=` parameter anymore (that used to work, but was
  exactly the hole this fix closes). To test for real, open your invite
  link from a second Telegram account, or lower the thresholds in
  `server/store.js` temporarily and have one real friend try it.
- Withdrawal unlocks once a user has invited enough friends, and enough of
  those friends have watched enough ads themselves — the exact numbers live
  in one place, `server/store.js`:

  ```js
  const REQUIRED_INVITES = 15;
  const REQUIRED_QUALIFYING_INVITES = 5;
  const QUALIFYING_ADS_THRESHOLD = 50;
  const POINTS_PER_ETB = 1;
  ```

  Change any of those and the API, the Withdraw tab's copy, and the progress
  bars all update automatically — nothing else to touch.

**Worth knowing:** that's a steep bar (15 invites, 5 of whom watch 50 ads
each — 250+ ad views total before anyone can withdraw). That's fine for a
demo, but if this ever goes to real users, extremely hard-to-reach payout
thresholds are a pattern people notice and lose trust in fast. Worth
reconsidering the numbers if this becomes more than a class project.

**This does not send real money.** Tapping "Request Withdrawal" creates a
record you see in `/admin.html` under "Withdrawal requests" — you then send
the ETB yourself (bank transfer, Telebirr, etc.) and click "Mark paid".
Wiring up an actual payment API is a separate, much bigger task involving
a business account and compliance work, not something to bolt on lightly.

## Admin dashboard

Visit `/admin.html` (e.g. `https://your-ngrok-url/admin.html`) for a stats
view: total users, points issued, ads watched, a 7-day activity chart, the
leaderboard, recent activity, and pending withdrawal requests you can mark
as paid once you've actually sent the money.

It's gated by a key you set yourself — put anything you like in `.env` as
`ADMIN_KEY`, restart the server, then enter that same value on the
`/admin.html` page. This is a simple shared-password gate, fine for a class
demo — it is **not** how you'd protect a real admin panel (no per-user
accounts, no rate limiting on guesses), so don't reuse this pattern if this
project ever handles real money.

## Anti-abuse limits already built in

`MAX_ADS_PER_DAY` and `MIN_SECONDS_BETWEEN_ADS` in `.env` cap how often one
user can farm points — this also mirrors what real ad networks require
(frequency capping), so it's good practice either way.

## Project structure

```
server/
  index.js           Express app + API routes
  bot.js             Telegraf bot (/start opens the Mini App)
  store.js           JSON-file data store (users, balances, history)
  verifyTelegram.js  Validates Telegram's signed initData
  store.js            Data layer — see "Persistent storage" below
public/
  index.html         Mini App markup
  style.css          Styling (adapts to the user's Telegram theme)
  app.js             Ad SDK wiring + UI logic
  admin.html         Admin dashboard markup
  admin.js           Admin dashboard logic
```
