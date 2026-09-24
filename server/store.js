// Persistent store backed by Upstash Redis.
//
// This used to keep the whole app's data as ONE JSON blob under a single
// key, with every write serialized through a global lock. That was safe
// but does not scale: at real concurrency (hundreds of thousands of users),
// every single ad-watch across every user would wait in line for the same
// lock, capping the whole app's throughput to whatever one lock can push
// through.
//
// Instead, each user's data lives under its own Redis keys, updated with
// Redis's own atomic per-key operations (HINCRBY, INCR, SET ... NX, sorted
// sets). Different users' requests never contend with each other at all —
// there is no shared blob and no global lock on the hot path. The only
// remaining lock is scoped to a single user's own withdrawal request (see
// withUserLock), which only matters if that one user double-submits.

const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = Redis.fromEnv(); // reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN

// Key layout:
//   user:{id}            hash   name, balance, adsWatchedTotal, referredBy,
//                                createdAt, pendingWithdrawalId, latestWithdrawalId
//   invited:{id}         set    ids of users this user directly referred
//   ads:{id}:{day}       string per-day ad-watch counter (auto-expires)
//   cooldown:{id}        string presence = still in the post-ad cooldown window
//   history:{id}         list   this user's recent reward events, newest first
//   events:global        list   recent reward events across all users (admin feed)
//   leaderboard          zset   id -> balance, for O(log n) top-N lookups
//   withdrawals          hash   requestId -> full request object
//   withdrawals:list     list   requestId, newest first
//   stats:totalUsers/totalPointsIssued/totalAdsWatched   counters
//   stats:adsToday:{day} counter, stats:activeUsers:{day} set

const LEADERBOARD_KEY = 'leaderboard';
const EVENTS_KEY = 'events:global';
const WITHDRAWALS_KEY = 'withdrawals';
const WITHDRAWALS_LIST_KEY = 'withdrawals:list';
const STATS_USERS_KEY = 'stats:totalUsers';
const STATS_POINTS_KEY = 'stats:totalPointsIssued';
const STATS_ADS_KEY = 'stats:totalAdsWatched';
const DAY_TTL_SECONDS = 60 * 60 * 24 * 2; // 2 days — comfortably outlives "today"

// Withdrawal eligibility rules — change these numbers here and everything
// (API, frontend copy) reads from this single source of truth.
const REQUIRED_INVITES = 15;
const REQUIRED_QUALIFYING_INVITES = 5;
const QUALIFYING_ADS_THRESHOLD = 50;
const POINTS_PER_ETB = 1;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function pushCapped(key, value, maxLen) {
  await redis.lpush(key, value);
  await redis.ltrim(key, 0, maxLen - 1);
}

async function incrWithExpiry(key, ttlSeconds) {
  const val = await redis.incr(key);
  if (val === 1) await redis.expire(key, ttlSeconds);
  return val;
}

// The Upstash REST client returns null (not an array of nulls) from HMGET
// when the key doesn't exist at all — unlike standard Redis protocol
// behavior. Destructuring that directly (const [a, b] = await hmget(...))
// throws "null is not iterable" instead of just giving you nulls. This
// wrapper normalizes both cases so every call site can destructure safely.
async function safeHmget(key, ...fields) {
  const result = await redis.hmget(key, ...fields);
  return result === null ? fields.map(() => null) : result;
}

// Scoped to ONE user — only matters if that same user double-submits a
// withdrawal at the same instant. Never blocks any other user's requests,
// unlike the old global lock this replaces.
async function withUserLock(id, fn, { retries = 20, retryDelayMs = 50 } = {}) {
  const lockKey = `lock:user:${id}`;
  const token = crypto.randomUUID();

  for (let attempt = 0; attempt < retries; attempt++) {
    const acquired = await redis.set(lockKey, token, { nx: true, px: 5000 });
    if (acquired) {
      try {
        return await fn();
      } finally {
        const current = await redis.get(lockKey);
        if (current === token) await redis.del(lockKey);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs + Math.random() * 30));
  }
  throw new Error('user_lock_timeout');
}

async function getOrCreateUser(id, name, referredBy) {
  const userKey = `user:${id}`;

  // HSETNX only sets 'balance' if the hash doesn't already have that field —
  // its return value doubles as an atomic "did I just create this user?"
  // check, with no separate lock needed. Two simultaneous first-opens of
  // the same brand-new user can't both think they created it.
  const created = await redis.hsetnx(userKey, 'balance', 0);

  if (created) {
    await redis.hset(userKey, {
      name: name || `User ${id}`,
      adsWatchedTotal: 0,
      createdAt: new Date().toISOString(),
      referredBy: '',
      pendingWithdrawalId: '',
      latestWithdrawalId: '',
    });
    await redis.zadd(LEADERBOARD_KEY, { score: 0, member: id });
    await redis.incr(STATS_USERS_KEY);

    // Only link the referral once, at creation, and never let someone be
    // credited as their own referrer.
    if (referredBy && referredBy !== id) {
      const referrerExists = await redis.hexists(`user:${referredBy}`, 'balance');
      if (referrerExists) {
        await redis.hset(userKey, { referredBy });
        await redis.sadd(`invited:${referredBy}`, id);
      }
    }
  }

  return getUser(id);
}

async function getUser(id) {
  const userKey = `user:${id}`;
  const exists = await redis.hexists(userKey, 'balance');
  if (!exists) return null;

  const [hash, todayCount, history, invitedIds] = await Promise.all([
    redis.hgetall(userKey),
    redis.get(`ads:${id}:${todayKey()}`),
    redis.lrange(`history:${id}`, 0, 19),
    redis.smembers(`invited:${id}`),
  ]);

  return {
    id,
    name: hash.name,
    balance: Number(hash.balance) || 0,
    adsWatchedTotal: Number(hash.adsWatchedTotal) || 0,
    adsWatchedToday: Number(todayCount) || 0,
    history: history || [],
    referredBy: hash.referredBy || null,
    invitedUserIds: invitedIds || [],
  };
}

// Returns { ok: true, user } or { ok: false, reason }
async function creditAdReward(id, amount, { maxPerDay, minSecondsBetween }) {
  const userKey = `user:${id}`;
  const [balance, name] = await safeHmget(userKey, 'balance', 'name');
  if (balance === null) return { ok: false, reason: 'unknown_user' };

  // Cooldown: atomically "claim" the current window. If this fails,
  // someone (or a double-tap from this same user) already claimed it —
  // race-free, no read-then-check gap.
  const cooldownKey = `cooldown:${id}`;
  const gotSlot = await redis.set(cooldownKey, '1', { nx: true, px: minSecondsBetween * 1000 });
  if (!gotSlot) {
    const ttlMs = await redis.pttl(cooldownKey);
    return { ok: false, reason: 'too_soon', waitSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
  }

  // Daily limit: atomic increment is the authoritative check even under
  // concurrency. If this particular attempt turns out to be over the
  // limit, roll both side effects back so it doesn't wrongly block a
  // legitimate future attempt today.
  const today = todayKey();
  const dayKey = `ads:${id}:${today}`;
  const newDailyCount = await redis.incr(dayKey);
  if (newDailyCount === 1) await redis.expire(dayKey, DAY_TTL_SECONDS);

  if (newDailyCount > maxPerDay) {
    await Promise.all([redis.decr(dayKey), redis.del(cooldownKey)]);
    return { ok: false, reason: 'daily_limit_reached' };
  }

  await Promise.all([
    redis.hincrby(userKey, 'balance', amount),
    redis.hincrby(userKey, 'adsWatchedTotal', 1),
    redis.zincrby(LEADERBOARD_KEY, amount, id),
    redis.incrby(STATS_POINTS_KEY, amount),
    redis.incr(STATS_ADS_KEY),
    incrWithExpiry(`stats:adsToday:${today}`, DAY_TTL_SECONDS),
    redis.sadd(`stats:activeUsers:${today}`, id),
    pushCapped(`history:${id}`, { at: new Date().toISOString(), amount }, 20),
    pushCapped(EVENTS_KEY, { at: new Date().toISOString(), userId: id, name, amount }, 200),
  ]);
  redis.expire(`stats:activeUsers:${today}`, DAY_TTL_SECONDS).catch(() => {});

  return { ok: true, user: await getUser(id) };
}

async function getLeaderboard(limit = 10) {
  // Highest score (balance) first.
  const topIds = await redis.zrange(LEADERBOARD_KEY, 0, limit - 1, { rev: true });
  if (!topIds.length) return [];

  const entries = await Promise.all(
    topIds.map(async (id) => {
      const [name, balance] = await safeHmget(`user:${id}`, 'name', 'balance');
      return { name, balance: Number(balance) || 0 };
    })
  );
  return entries;
}

async function getRecentEvents(limit = 20) {
  return redis.lrange(EVENTS_KEY, 0, limit - 1);
}

async function getStats() {
  const today = todayKey();
  const [totalUsers, totalPointsIssued, totalAdsWatched, adsWatchedToday, activeUsersToday] = await Promise.all([
    redis.get(STATS_USERS_KEY),
    redis.get(STATS_POINTS_KEY),
    redis.get(STATS_ADS_KEY),
    redis.get(`stats:adsToday:${today}`),
    redis.scard(`stats:activeUsers:${today}`),
  ]);

  return {
    totalUsers: Number(totalUsers) || 0,
    totalPointsIssued: Number(totalPointsIssued) || 0,
    totalAdsWatched: Number(totalAdsWatched) || 0,
    adsWatchedToday: Number(adsWatchedToday) || 0,
    activeUsersToday: Number(activeUsersToday) || 0,
  };
}

async function getReferralStatus(id) {
  const userKey = `user:${id}`;
  const exists = await redis.hexists(userKey, 'balance');
  if (!exists) return null;

  const invitedIds = await redis.smembers(`invited:${id}`);
  const invitedCount = invitedIds.length;

  let qualifyingCount = 0;
  if (invitedIds.length) {
    const totals = await Promise.all(invitedIds.map((uid) => redis.hget(`user:${uid}`, 'adsWatchedTotal')));
    qualifyingCount = totals.filter((t) => Number(t) >= QUALIFYING_ADS_THRESHOLD).length;
  }

  const eligible = invitedCount >= REQUIRED_INVITES && qualifyingCount >= REQUIRED_QUALIFYING_INVITES;

  const [pendingId, latestId] = await safeHmget(userKey, 'pendingWithdrawalId', 'latestWithdrawalId');

  let hasPendingRequest = false;
  let latestRequestStatus = null;

  if (latestId) {
    const latestReq = await redis.hget(WITHDRAWALS_KEY, latestId);
    latestRequestStatus = latestReq ? latestReq.status : null;
  }
  if (pendingId) {
    // Trust the flag but confirm it's still actually pending, in case a
    // status update ever failed partway through clearing it.
    const pendingReq = await redis.hget(WITHDRAWALS_KEY, pendingId);
    hasPendingRequest = Boolean(pendingReq && pendingReq.status === 'pending');
  }

  return {
    invitedCount,
    qualifyingCount,
    requiredInvites: REQUIRED_INVITES,
    requiredQualifyingInvites: REQUIRED_QUALIFYING_INVITES,
    qualifyingAdsThreshold: QUALIFYING_ADS_THRESHOLD,
    pointsPerEtb: POINTS_PER_ETB,
    eligible,
    hasPendingRequest,
    latestRequestStatus,
  };
}

// Returns { ok: true, request } or { ok: false, reason }
async function requestWithdrawal(id) {
  const userKey = `user:${id}`;
  const exists = await redis.hexists(userKey, 'balance');
  if (!exists) return { ok: false, reason: 'unknown_user' };

  return withUserLock(id, async () => {
    const status = await getReferralStatus(id);
    if (!status.eligible) return { ok: false, reason: 'not_eligible' };
    if (status.hasPendingRequest) return { ok: false, reason: 'already_pending' };

    const [name, balance] = await safeHmget(userKey, 'name', 'balance');
    const request = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: id,
      name,
      points: Number(balance) || 0,
      etb: (Number(balance) || 0) * POINTS_PER_ETB,
      at: new Date().toISOString(),
      status: 'pending',
    };

    await redis.hset(WITHDRAWALS_KEY, { [request.id]: request });
    await redis.lpush(WITHDRAWALS_LIST_KEY, request.id);
    await redis.hset(userKey, { pendingWithdrawalId: request.id, latestWithdrawalId: request.id });

    return { ok: true, request };
  });
}

async function listWithdrawalRequests() {
  const ids = await redis.lrange(WITHDRAWALS_LIST_KEY, 0, -1); // already newest-first
  if (!ids.length) return [];
  const requests = await Promise.all(ids.map((rid) => redis.hget(WITHDRAWALS_KEY, rid)));
  return requests.filter(Boolean);
}

async function setWithdrawalStatus(requestId, status) {
  const request = await redis.hget(WITHDRAWALS_KEY, requestId);
  if (!request) return null;

  request.status = status;
  await redis.hset(WITHDRAWALS_KEY, { [requestId]: request });

  if (status !== 'pending') {
    const userKey = `user:${request.userId}`;
    const currentPending = await redis.hget(userKey, 'pendingWithdrawalId');
    if (currentPending === requestId) await redis.hset(userKey, { pendingWithdrawalId: '' });
  }

  return request;
}

// Admin-only: directly set a user's balance and/or name. Creates the user
// if the id doesn't exist yet (useful for adding a manually-tracked entry).
// Returns the updated user record.
async function adminSetUser(id, { name, balance } = {}) {
  const userKey = `user:${id}`;
  const created = await redis.hsetnx(userKey, 'balance', 0);

  if (created) {
    await redis.hset(userKey, {
      name: name || `User ${id}`,
      adsWatchedTotal: 0,
      createdAt: new Date().toISOString(),
      referredBy: '',
      pendingWithdrawalId: '',
      latestWithdrawalId: '',
    });
    await redis.zadd(LEADERBOARD_KEY, { score: 0, member: id });
    await redis.incr(STATS_USERS_KEY);
  }

  if (name !== undefined && name !== null && name !== '') {
    await redis.hset(userKey, { name });
  }

  if (balance !== undefined && balance !== null && Number.isFinite(Number(balance))) {
    const newBalance = Math.max(0, Number(balance));
    const oldBalance = Number(await redis.hget(userKey, 'balance')) || 0;
    const delta = newBalance - oldBalance;

    await redis.hset(userKey, { balance: newBalance });
    await redis.zadd(LEADERBOARD_KEY, { score: newBalance, member: id });
    if (delta !== 0) await redis.incrby(STATS_POINTS_KEY, delta);
  }

  return getUser(id);
}

module.exports = {
  getOrCreateUser,
  getUser,
  creditAdReward,
  getLeaderboard,
  getRecentEvents,
  getStats,
  getReferralStatus,
  requestWithdrawal,
  listWithdrawalRequests,
  setWithdrawalStatus,
  adminSetUser,
};
