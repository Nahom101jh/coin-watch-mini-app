// Persistent store backed by Upstash Redis (a free, permanent, genuinely
// persistent key-value store — unlike Render's free-tier disk, which gets
// wiped on every container restart). The whole app's data lives under one
// Redis key, as a single JSON blob, mirroring the old file-based shape so
// nothing else in the codebase needed to change except awaiting these calls.

const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv(); // reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN

const DB_KEY = 'coin-watch:db';

// Withdrawal eligibility rules — change these numbers here and everything
// (API, frontend copy) reads from this single source of truth.
const REQUIRED_INVITES = 15;
const REQUIRED_QUALIFYING_INVITES = 5;
const QUALIFYING_ADS_THRESHOLD = 50;
const POINTS_PER_ETB = 1;

async function load() {
  const db = await redis.get(DB_KEY);
  if (!db) return { users: {}, events: [], withdrawalRequests: [] };

  if (!db.events) db.events = [];
  if (!db.withdrawalRequests) db.withdrawalRequests = [];

  // Upgrade any user records saved before referrals existed, so old data
  // never crashes new code — missing fields just default to empty.
  for (const user of Object.values(db.users || {})) {
    if (!Array.isArray(user.invitedUserIds)) user.invitedUserIds = [];
    if (user.referredBy === undefined) user.referredBy = null;
  }

  return db;
}

async function save(db) {
  await redis.set(DB_KEY, db);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function getOrCreateUser(id, name, referredBy) {
  const db = await load();
  if (!db.users[id]) {
    db.users[id] = {
      id,
      name: name || `User ${id}`,
      balance: 0,
      adsWatchedTotal: 0,
      adsWatchedToday: 0,
      lastAdDay: todayKey(),
      lastAdAt: 0,
      history: [], // recent reward events, newest first
      referredBy: null,
      invitedUserIds: [],
    };

    // Only link the referral once, at creation, and never let someone be
    // credited as their own referrer.
    if (referredBy && referredBy !== id && db.users[referredBy]) {
      db.users[id].referredBy = referredBy;
      const referrer = db.users[referredBy];
      if (!referrer.invitedUserIds.includes(id)) referrer.invitedUserIds.push(id);
    }

    await save(db);
  }
  return db.users[id];
}

async function getUser(id) {
  const db = await load();
  return db.users[id] || null;
}

// Returns { ok: true, user } or { ok: false, reason }
async function creditAdReward(id, amount, { maxPerDay, minSecondsBetween }) {
  const db = await load();
  const user = db.users[id];
  if (!user) return { ok: false, reason: 'unknown_user' };

  const today = todayKey();
  if (user.lastAdDay !== today) {
    user.lastAdDay = today;
    user.adsWatchedToday = 0;
  }

  const secondsSinceLast = (Date.now() - user.lastAdAt) / 1000;
  if (user.lastAdAt && secondsSinceLast < minSecondsBetween) {
    return { ok: false, reason: 'too_soon', waitSeconds: Math.ceil(minSecondsBetween - secondsSinceLast) };
  }

  if (user.adsWatchedToday >= maxPerDay) {
    return { ok: false, reason: 'daily_limit_reached' };
  }

  user.balance += amount;
  user.adsWatchedTotal += 1;
  user.adsWatchedToday += 1;
  user.lastAdAt = Date.now();
  user.history.unshift({ at: new Date().toISOString(), amount });
  user.history = user.history.slice(0, 20);

  db.users[id] = user;
  db.events.unshift({ at: new Date().toISOString(), userId: id, name: user.name, amount });
  db.events = db.events.slice(0, 200); // keep the log bounded

  await save(db);
  return { ok: true, user };
}

async function getLeaderboard(limit = 10) {
  const db = await load();
  return Object.values(db.users)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit)
    .map((u) => ({ name: u.name, balance: u.balance }));
}

async function getRecentEvents(limit = 20) {
  const db = await load();
  return db.events.slice(0, limit);
}

async function getStats() {
  const db = await load();
  const users = Object.values(db.users);
  const today = todayKey();

  return {
    totalUsers: users.length,
    totalPointsIssued: users.reduce((sum, u) => sum + u.balance, 0),
    totalAdsWatched: users.reduce((sum, u) => sum + u.adsWatchedTotal, 0),
    adsWatchedToday: users.reduce((sum, u) => sum + (u.lastAdDay === today ? u.adsWatchedToday : 0), 0),
    activeUsersToday: users.filter((u) => u.lastAdDay === today && u.adsWatchedToday > 0).length,
  };
}

async function getReferralStatus(id) {
  const db = await load();
  const user = db.users[id];
  if (!user) return null;

  const invited = user.invitedUserIds.map((uid) => db.users[uid]).filter(Boolean);
  const qualifyingCount = invited.filter((u) => u.adsWatchedTotal >= QUALIFYING_ADS_THRESHOLD).length;
  const invitedCount = invited.length;
  const eligible = invitedCount >= REQUIRED_INVITES && qualifyingCount >= REQUIRED_QUALIFYING_INVITES;

  const myRequests = db.withdrawalRequests.filter((r) => r.userId === id);
  const pending = myRequests.find((r) => r.status === 'pending') || null;
  const latest = myRequests[myRequests.length - 1] || null;

  return {
    invitedCount,
    qualifyingCount,
    requiredInvites: REQUIRED_INVITES,
    requiredQualifyingInvites: REQUIRED_QUALIFYING_INVITES,
    qualifyingAdsThreshold: QUALIFYING_ADS_THRESHOLD,
    pointsPerEtb: POINTS_PER_ETB,
    eligible,
    hasPendingRequest: Boolean(pending),
    latestRequestStatus: latest ? latest.status : null,
  };
}

// Returns { ok: true, request } or { ok: false, reason }
async function requestWithdrawal(id) {
  const db = await load();
  const user = db.users[id];
  if (!user) return { ok: false, reason: 'unknown_user' };

  const status = await getReferralStatus(id);
  if (!status.eligible) return { ok: false, reason: 'not_eligible' };
  if (status.hasPendingRequest) return { ok: false, reason: 'already_pending' };

  const request = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: id,
    name: user.name,
    points: user.balance,
    etb: user.balance * POINTS_PER_ETB,
    at: new Date().toISOString(),
    status: 'pending',
  };
  db.withdrawalRequests.push(request);
  await save(db);
  return { ok: true, request };
}

async function listWithdrawalRequests() {
  const db = await load();
  return [...db.withdrawalRequests].reverse(); // newest first
}

async function setWithdrawalStatus(requestId, status) {
  const db = await load();
  const request = db.withdrawalRequests.find((r) => r.id === requestId);
  if (!request) return null;
  request.status = status;
  await save(db);
  return request;
}

// Admin-only: directly set a user's balance and/or name. Creates the user
// if the id doesn't exist yet (useful for adding a manually-tracked entry).
// Returns the updated user record.
async function adminSetUser(id, { name, balance } = {}) {
  const db = await load();

  if (!db.users[id]) {
    db.users[id] = {
      id,
      name: name || `User ${id}`,
      balance: 0,
      adsWatchedTotal: 0,
      adsWatchedToday: 0,
      lastAdDay: todayKey(),
      lastAdAt: 0,
      history: [],
      referredBy: null,
      invitedUserIds: [],
    };
  }

  if (name !== undefined && name !== null && name !== '') db.users[id].name = name;
  if (balance !== undefined && balance !== null && Number.isFinite(Number(balance))) {
    db.users[id].balance = Math.max(0, Number(balance));
  }

  await save(db);
  return db.users[id];
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
